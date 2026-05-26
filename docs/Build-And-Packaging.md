# Build and Packaging

The desktop app is bundled with
[electron-builder](https://www.electron.build/) into a macOS `.dmg`
(Apple Silicon arm64 target), a Linux `AppImage`, and a Windows
`nsis` installer. The default `npm run build` produces all three when
run on the matching host; CI uses
`npm run build:mac` / `:linux` / `:win` to target one platform.

Config: [`electron-builder.yml`](https://github.com/VivaldiCode/voice-gateway/blob/main/electron-builder.yml).
Pre-bundle Vite build:
[`electron.vite.config.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/electron.vite.config.ts).

## Pipeline

```mermaid
flowchart LR
    Src[src/] --> Vite[electron-vite build]
    Vite --> Out[out/main, out/preload, out/renderer]
    Out --> EB[electron-builder]
    Resources[resources/] --> EB
    EB --> Pack[app packed in .app/.exe/.AppImage]
    Pack --> Hook[afterPack hook<br>build/after-pack.cjs]
    Hook --> Dmg[release/*.dmg]
```

### electron-vite

Three build outputs:

| Bundle    | Format | Entry                 | Why                                                    |
|-----------|--------|-----------------------|--------------------------------------------------------|
| `main`    | ESM    | `src/main/index.ts`   | Modern Node ESM, top-level await available             |
| `preload` | **CJS**| `src/preload/index.ts`| Electron's sandboxed preload doesn't support ESM yet   |
| `renderer`| ESM    | `src/renderer/main.tsx` | React 18 + Vite HMR in dev                            |

The preload-as-CJS rule is a recurring bite point — see
[electron/electron #28981](https://github.com/electron/electron/issues/28981).
Vite is told `format: 'cjs', extension: '.cjs'` for that bundle so the
main process can `require()` the absolute path
`join(__dirname, '../preload/index.cjs')`.

The dev server:

```bash
npm run dev   # electron-vite dev — HMR on the renderer, restart on main changes
```

The dev server only handles the renderer; the main process is just
re-spawned on every TypeScript change.

## extraResources

```yaml
extraResources:
  - from: resources/python    → to: python      # wake_word_runner.py + requirements.txt
  - from: resources/piper     → to: piper       # (currently empty; voices live in userData)
  - from: resources/scripts   → to: scripts     # any one-off shell helpers
  - from: resources/icon.png  → to: icon.png    # used by Tray + window icon
  - from: resources/icon.svg  → to: icon.svg
  - from: resources/icons     → to: icons       # icon-16/32/64/...png
```

These end up in `Contents/Resources/` on macOS and
`resources/` on Linux/Windows. The main process picks them up via
`process.resourcesPath` — see
[`src/main/asset-paths.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/main/asset-paths.ts).

## macOS code signing

We **don't** have an Apple Developer ID. The build is ad-hoc-signed
instead — `codesign --sign -` — which is enough for the OS to remember
TCC permission grants across rebuilds.

The trick is that electron-builder's `identity: false` config doesn't
actually run `codesign` itself. It hands you a bundle whose binaries
are only "linker-signed" with a stale `Identifier=Electron`. macOS TCC
binds permissions to the
[Designated Requirement](https://developer.apple.com/documentation/security/code_signing_services)
of the bundle, so a fresh "Electron" identifier every rebuild means
every rebuild looks like a different app and the user's microphone
grant evaporates.

The
[`afterPack` hook](https://github.com/VivaldiCode/voice-gateway/blob/main/build/after-pack.cjs)
fixes this:

```js
execSync(
  `codesign --force --deep --options runtime --timestamp=none ` +
  `--entitlements build/entitlements.mac.plist --sign - "${appPath}"`,
);
```

| Flag                | Why                                                            |
|---------------------|----------------------------------------------------------------|
| `--force`           | Replace existing (linker-only) signatures                      |
| `--deep`            | Walk into Frameworks/ and resign every helper                  |
| `--options runtime` | Turn on the hardened runtime (otherwise entitlements ignored)  |
| `--timestamp=none`  | Skip Apple's TSA — we don't need notarization                  |
| `--entitlements …`  | Inject `audio-input`, `allow-jit`, `disable-library-validation` |
| `--sign -`          | Ad-hoc identity (no Developer ID needed)                       |

After signing, the hook also runs `codesign -dv` to print the resulting
signature info into the build log — useful when chasing "why is macOS
asking for permission again?" issues.

## Helper Info.plist patching

macOS checks `NSMicrophoneUsageDescription` on the **helper bundle's**
Info.plist, not just the main app's. electron-builder copies prebuilt
helper bundles verbatim from the Electron release tarball — they ship
with empty plists. Without the key, `getUserMedia({audio:true})` hangs
forever or rejects with `AbortError` even though the user clicked
Allow on the main app's prompt.

The same `afterPack` hook injects the key into every helper:

```js
for (const helper of fs.readdirSync(frameworksDir).filter(e => e.endsWith('.app'))) {
  const plistPath = path.join(frameworksDir, helper, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) continue;
  execFileSync('plutil', ['-insert', 'NSMicrophoneUsageDescription', '-string', MIC_DESC, plistPath]);
}
```

See [[macOS-Permissions]] for the full rationale.

## Entitlements

[`build/entitlements.mac.plist`](https://github.com/VivaldiCode/voice-gateway/blob/main/build/entitlements.mac.plist):

```xml
<key>com.apple.security.device.audio-input</key>             <!-- mic permission -->
<key>com.apple.security.cs.allow-jit</key>                   <!-- V8 JIT          -->
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<key>com.apple.security.cs.allow-dyld-environment-variables</key>
<key>com.apple.security.cs.disable-library-validation</key>  <!-- spawn whisper, piper, python -->
```

The last two are essential because we spawn external binaries
(`whisper-cli`, `piper`, `python3`). With hardened-runtime library
validation enabled, those child processes inherit our restrictions
and refuse to load anything not signed by us — which is fine for
Apple binaries but breaks Homebrew's whisper-cli the moment it tries
to load `libomp.dylib`.

## Resource-fork cleanup

The repo is sometimes mounted from an exFAT external disk, which
sprinkles `._*` AppleDouble files alongside every real file. They get
copied into the bundle and break codesign with "Operation not
permitted". The hook does a defensive cleanup:

```js
execFileSync('find', [appPath, '-name', '._*', '-delete'], { stdio: 'pipe' });
```

## Linux + Windows

Linux:

```yaml
linux:
  target: [AppImage]
  category: AudioVideo
  icon: resources/icon.png
```

AppImage builds are unsigned and require no Apple-equivalent ceremony.

Windows:

```yaml
win:
  target: [{ target: nsis, arch: [x64] }]
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
```

Neither is regularly exercised by maintainers today — macOS is the
primary target.

## Asar = false

```yaml
asar: false
```

We disable asar so the on-disk layout under `Contents/Resources/app/`
is greppable. With ~50 MB of compiled output the size cost is
negligible.

## CI / Release pipeline

PR validation runs in
[`.github/workflows/ci.yml`](https://github.com/VivaldiCode/voice-gateway/blob/main/.github/workflows/ci.yml)
(lint + typecheck + vitest matrix + Playwright + Pytest + CodeQL).

DMG release runs in a separate workflow,
[`.github/workflows/release.yml`](https://github.com/VivaldiCode/voice-gateway/blob/main/.github/workflows/release.yml),
that fires on `v*` tag pushes. The split keeps PR runs cheap — the
DMG build is slow and is only needed when shipping.

Release flow:

1. Tag the release commit:
   ```bash
   git tag -a v0.X.Y -m "Voice Gateway 0.X.Y — <one-liner>"
   git push origin v0.X.Y
   ```
2. The workflow runs on `macos-latest`:
   `npm ci` → `npm run build` →
   `npx electron-builder --mac --arm64 --publish never` →
   upload artifact → publish/update the GitHub Release via
   [`softprops/action-gh-release@v2`](https://github.com/softprops/action-gh-release).
3. The DMG ends up attached to the Release; release notes are
   auto-generated unless a manual `gh release create` was run first
   for the same tag (in which case the manual notes survive and
   only the DMG asset gets updated).

The `--publish never` flag is load-bearing: without it,
`electron-builder` detects the tag context, tries to publish to
GitHub Releases itself, fails on missing `GH_TOKEN`, and aborts the
whole job before the DMG is written. The rule: **exactly one
publisher per release** — `softprops/action-gh-release@v2`. See
issue #50 for the failure mode this guards against.

For ad-hoc local builds, the `build:mac` npm script is enough; it
runs on the local machine and never tries to publish:

```bash
npm test
npm run build:mac
ls release/*.dmg          # → Voice Gateway-0.X.Y-arm64.dmg
```

A future Linux + Windows publish matrix would add `ubuntu-latest`
+ `windows-latest` runners with the matching `build:linux` /
`build:win` scripts. Today only macOS arm64 ships through CI.

## Troubleshooting build failures

| Symptom                                                  | Likely cause                                                      |
|----------------------------------------------------------|-------------------------------------------------------------------|
| `codesign: object file format invalid or unsuitable`     | A stray `._*` AppleDouble file slipped into the bundle. The hook handles this; if it returns, check that `find` succeeded. |
| `Library not loaded: @rpath/Electron Framework`          | A helper wasn't re-signed. The hook walks Frameworks/; if you added new helpers, re-check. |
| Renderer blank after install                             | Vite's renderer outDir doesn't match `loadFile` path. The pattern is `out/renderer/index.html` → `join(__dirname, '../renderer/index.html')`. |
| Microphone permission lost across rebuilds               | Ad-hoc signing failed silently; check the `[after-pack]` codesign output for "main signature: <stuff>". |
| `hdiutil: create failed - No space left on device`       | The default `electron-builder` DMG path stages its temp file in `/private/var/folders/...` — i.e. on the system volume. If that volume is low on free space, `hdiutil` aborts even though the source bundle is small. **Workaround:** run `hdiutil create` manually with `TMPDIR` pointed at a roomier volume (typically the same drive that holds the source tree). The output DMG is identical for the end user; only the staging directory differs. |

Manual DMG when `/var/folders` is full:

```bash
TMPDIR=/Volumes/External\ 01/.tmp \
  hdiutil create \
    -srcfolder "release/mac-arm64/Voice Gateway.app" \
    -volname "Voice Gateway 0.1.0-arm64" \
    -anyowners -nospotlight \
    -format UDZO -fs HFS+ \
    "release/Voice Gateway-0.1.0-arm64.dmg"
```

Run `npm run build:mac --verbose` to see the full electron-builder log
plus our afterPack output.
