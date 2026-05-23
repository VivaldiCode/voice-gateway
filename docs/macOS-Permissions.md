# macOS Permissions

macOS' Transparency, Consent, and Control (TCC) framework gates
microphone access on three things being aligned:

1. `NSMicrophoneUsageDescription` in the **main app** Info.plist.
2. `NSMicrophoneUsageDescription` in **every helper bundle** Info.plist.
3. `com.apple.security.device.audio-input` in the bundle's signed
   entitlements (hardened runtime).

Miss any one of these and `getUserMedia({audio:true})` fails — but
"fails" looks different each time. Sometimes the OS prompt never
appears. Sometimes it does, but the next call hangs forever. Sometimes
the promise rejects with `AbortError` whose `.message` is just `"The
user aborted a request."` — a lie, because the user did no such thing.

This page is the canonical reference for what each piece does and why
the [[Build-And-Packaging|build pipeline]] is shaped the way it is.

## The big picture

```mermaid
flowchart TB
    subgraph Bundle["Voice Gateway.app"]
        Main[Contents/MacOS/Voice Gateway]
        MainPlist[Contents/Info.plist<br>NSMicrophoneUsageDescription ✓]
        subgraph Frameworks
            Helper[Voice Gateway Helper.app]
            HelperPlist[Helper Info.plist<br>NSMicrophoneUsageDescription ✓<br>injected by afterPack]
            Audio[Voice Gateway Helper (Audio).app]
            AudioPlist[...]
        end
        Ent[entitlements.mac.plist<br>audio-input ✓]
    end

    User[User clicks Talk] --> Worklet[AudioWorklet getUserMedia]
    Worklet --> Renderer[Renderer process]
    Renderer --> AudioSvc{Audio Service<br>helper or main?}
    AudioSvc -- "out of process<br>(default)" --> Helper
    AudioSvc -- "in-process<br>(our switch)" --> Main
    Main --> TCC{TCC check<br>against bundle DR}
    Helper --> TCC
    TCC -- granted --> Mic[Mic opens]
    TCC -- denied or missing plist key --> Abort[AbortError]
```

## Why three places?

### 1. Main app Info.plist

The OS reads `NSMicrophoneUsageDescription` to **populate the prompt
dialog**. Missing key → no prompt, immediate failure.

electron-builder writes this via the `mac.extendInfo` block:

```yaml
mac:
  extendInfo:
    NSMicrophoneUsageDescription: A Voice Gateway precisa do microfone para gravar o que dizes ao Hermes.
```

### 2. Helper bundles' Info.plist (the obscure one)

By default Chromium runs the audio service **out of process** in a
helper bundle (`Voice Gateway Helper (Audio).app`). The helper has its
own bundle identifier and its own TCC subject. When `getUserMedia`
fires, the helper opens the OS audio device — and the OS checks the
**helper's** plist, not the main app's.

electron-builder copies prebuilt helper bundles verbatim from the
Electron tarball — they ship with empty plists. So even though our
main bundle has the key, the helper doesn't, and the mic open silently
times out.

The
[`afterPack` hook](https://github.com/VivaldiCode/voice-gateway/blob/main/build/after-pack.cjs)
injects the key into every helper found under `Contents/Frameworks`:

```js
for (const helper of helpers) {
  const plistPath = path.join(frameworksDir, helper, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) continue;
  execFileSync('plutil', ['-insert', 'NSMicrophoneUsageDescription',
                          '-string', MIC_DESC, plistPath]);
}
```

### 3. Audio-input entitlement

The hardened runtime requires `com.apple.security.device.audio-input`
in the signed entitlements. Without it, even with both plists in
order, `getUserMedia` rejects with `AbortError`.

[`build/entitlements.mac.plist`](https://github.com/VivaldiCode/voice-gateway/blob/main/build/entitlements.mac.plist):

```xml
<key>com.apple.security.device.audio-input</key>
<true/>
```

The entitlement file is passed to `codesign` via
`--entitlements build/entitlements.mac.plist`. If you forget the flag,
the bundle is signed but the entitlements are not embedded.

## Our workaround: in-process audio service

Even with all three pieces right, the helper-based audio service can
silently fail when the user grants permission to the **main** app but
the OS evaluates the helper's bundle ID as a separate TCC subject.

[`src/main/index.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/main/index.ts)
disables the out-of-process audio service:

```ts
// MUST be set BEFORE app.whenReady so Chromium picks it up at startup.
app.commandLine.appendSwitch(
  'disable-features',
  'AudioServiceOutOfProcess,AudioServiceSandbox',
);
```

This folds audio capture into the main browser process. The OS now
checks the main app's bundle ID (which the user has granted) and the
mic opens.

The trade-off is no audio-service sandbox. For a voice assistant where
every audio path is already trusted code, this is fine.

## Ad-hoc signing and the TCC cache

TCC caches a permission grant keyed by the bundle's **Designated
Requirement** (DR), a code-signing fingerprint. If the DR changes
between builds, the cached grant doesn't apply to the new build — the
user is prompted again, and any cross-build state is lost.

We sign every build ad-hoc (`--sign -`) so the DR is **stable across
rebuilds**. From the
[`afterPack` hook](https://github.com/VivaldiCode/voice-gateway/blob/main/build/after-pack.cjs):

```js
const args = [
  '--force', '--deep',
  '--options', 'runtime',
  '--timestamp=none',
  '--entitlements', entitlementsPath,
  '--sign', '-',           // ad-hoc identity
  appPath,
];
execSync(`codesign ${args.map(JSON.stringify).join(' ')}`);
```

Without this re-sign, electron-builder's `identity: false` leaves the
binaries only "linker-signed" with the upstream `Identifier=Electron`,
and every rebuild looks like a different app to TCC.

## Runtime permission wiring

Even with all the static signing right, Electron's renderer needs the
session permission handlers to accept the `media` permission request:

```ts
function wireMediaPermissions(): void {
  const GRANTED = new Set(['media', 'audioCapture', 'microphone']);
  session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(GRANTED.has(p)));
  session.defaultSession.setPermissionCheckHandler((_wc, p) => GRANTED.has(p));

  if (process.platform === 'darwin') {
    void systemPreferences.askForMediaAccess('microphone');
  }
}
```

The `askForMediaAccess` call **pre-prompts** the user on app launch
rather than at first PTT press, so the OS dialog can't get lost
behind another window during a hectic first-use session.

## Diagnosing a failure

In order of likelihood:

1. **Did the prompt ever appear?**
   - No → `NSMicrophoneUsageDescription` missing somewhere. Check
     `Contents/Info.plist` AND every Helper Info.plist:
     ```bash
     plutil -p "Voice Gateway.app/Contents/Info.plist" | grep -i mic
     find "Voice Gateway.app/Contents/Frameworks" -name 'Info.plist' \
       -exec plutil -p {} \; | grep -i mic
     ```
   - Yes but the app still says permission denied → the user clicked
     Deny. Send them to **Privacy → Microphone** to flip the switch.

2. **`AbortError: The user aborted a request.`**
   - Almost always missing `com.apple.security.device.audio-input`
     entitlement. Verify:
     ```bash
     codesign -d --entitlements - "Voice Gateway.app" | grep audio-input
     ```

3. **Permission was granted last time but now the prompt comes back.**
   - DR changed. Verify the bundle's signature is ad-hoc and stable:
     ```bash
     codesign -dr- "Voice Gateway.app"
     ```
     Should print `Identifier=dev.voicegateway.app`. If it prints
     `Identifier=Electron`, the resign didn't happen — check the
     `[after-pack]` build log.

4. **Audio context starts but no samples flow.**
   - `AudioServiceOutOfProcess` is still enabled. Check the build
     contains `disable-features=AudioServiceOutOfProcess,AudioServiceSandbox`:
     ```bash
     strings "Voice Gateway.app/Contents/MacOS/Voice Gateway" | grep -i audioservice
     ```

5. **Mic icon appears in menu bar but audio still silent.**
   - Some other app holds the device. macOS lets a second app open the
     device but doesn't always route samples. Quit Zoom / Discord /
     FaceTime / OBS and retry.

## Diagnostic UI

The **Microfone** tab in Settings calls
`vg:audio:mic-status` and renders a coloured pill:

| `getMediaAccessStatus()` | Pill colour | Action button                                   |
|--------------------------|-------------|-------------------------------------------------|
| `granted`                | green       | none                                            |
| `denied`                 | red         | "Abrir Definições do Sistema" (open Privacy)    |
| `not-determined`         | amber       | "Pedir permissão" → `systemPreferences.ask`     |
| `restricted` / `unknown` | grey        | help link                                       |

Implemented in
[`src/main/ipc-handlers.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/main/ipc-handlers.ts)
and consumed by
[`SettingsPanel.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/components/SettingsPanel.tsx).
