/**
 * electron-builder afterPack hook for macOS.
 *
 * Solves two bugs that bite ad-hoc-signed (unsigned-developer) Electron
 * builds on Apple Silicon:
 *
 *   1. macOS TCC checks NSMicrophoneUsageDescription on the *helper*
 *      process's Info.plist, not the main app's. electron-builder copies
 *      Electron's prebuilt helpers verbatim — they ship with empty plists
 *      and the missing key makes getUserMedia hang forever or reject with
 *      AbortError, even when the user has clicked Allow on the main app's
 *      prompt. Inject the key into every helper bundle.
 *
 *   2. electron-builder's `identity: false` doesn't actually run
 *      `codesign --sign -` on the bundle — the binaries end up only
 *      'linker-signed' with a stale `Identifier=Electron` from the
 *      prebuild. macOS TCC then can't reliably bind permissions to the
 *      app. Re-sign the whole .app `--deep --force --sign -` so every
 *      helper inherits the bundle identifier from its own Info.plist and
 *      the entitlements we ship.
 *
 * No-op on non-darwin builds.
 */
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MIC_DESC =
  'A Voice Gateway precisa do microfone para gravar o que dizes ao Hermes.';

function ensurePlistKey(plistPath, key, value) {
  // -insert errors when the key exists; fall back to -replace.
  try {
    execFileSync(
      'plutil',
      ['-insert', key, '-string', value, plistPath],
      { stdio: 'pipe' },
    );
  } catch (_e) {
    execFileSync(
      'plutil',
      ['-replace', key, '-string', value, plistPath],
      { stdio: 'pipe' },
    );
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${productFilename}.app`);
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  // ---------- 1. Patch helper Info.plists ----------
  if (fs.existsSync(frameworksDir)) {
    const helpers = fs
      .readdirSync(frameworksDir)
      .filter((e) => e.endsWith('.app'));
    for (const helper of helpers) {
      const plistPath = path.join(frameworksDir, helper, 'Contents', 'Info.plist');
      if (!fs.existsSync(plistPath)) continue;
      ensurePlistKey(plistPath, 'NSMicrophoneUsageDescription', MIC_DESC);
      console.log(`  + NSMicrophoneUsageDescription → ${helper}`);
    }
  }

  // ---------- 1b. Strip macOS resource forks ----------
  // The repo lives on an exFAT drive that sprinkles `._*` AppleDouble files
  // alongside every real file the moment we touch them. They get copied
  // into the bundle and then break codesign with "Operation not permitted"
  // because they're treated as extra (unsignable) resources.
  try {
    execFileSync('find', [appPath, '-name', '._*', '-delete'], { stdio: 'pipe' });
  } catch (e) {
    console.warn('[after-pack] resource-fork cleanup warning:', e.message);
  }

  // ---------- 2. Re-sign the whole bundle ----------
  // --deep walks frameworks + helpers; --force replaces existing signatures;
  // --options runtime enables the hardened runtime so the entitlements
  // file is actually consulted. Sign with `-` to do an ad-hoc identity.
  const entitlementsPath = path.resolve(
    context.packager.projectDir,
    'build',
    'entitlements.mac.plist',
  );
  const args = [
    '--force',
    '--deep',
    '--options', 'runtime',
    '--timestamp=none',
  ];
  if (fs.existsSync(entitlementsPath)) {
    args.push('--entitlements', entitlementsPath);
  }
  args.push('--sign', '-', appPath);

  console.log(`  + codesign ${args.join(' ')}`);
  execSync(`codesign ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
    stdio: 'inherit',
  });

  // ---------- 3. Smoke-check the result ----------
  try {
    const out = execFileSync('codesign', ['-dv', appPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    console.log('[after-pack] main signature:');
    out.split('\n').forEach((l) => l && console.log('    ' + l));
  } catch (e) {
    console.warn('[after-pack] codesign -dv failed:', e.message);
  }
};
