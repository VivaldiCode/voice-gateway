/**
 * macOS GUI apps inherit a minimal PATH (typically /usr/bin:/bin:/usr/sbin:
 * /sbin) when launched from Finder, Dock, or Spotlight. They do NOT inherit
 * the user's shell PATH, so anything installed via Homebrew or MacPorts is
 * invisible to spawned subprocesses.
 *
 * We don't try to reproduce the user's shell here (that requires parsing
 * dotfiles or shelling out, both fragile). Instead we prepend the
 * well-known package-manager bin directories so `which whisper-cli` and
 * friends just work out-of-the-box.
 *
 * Call this once during main-process boot, before any service is spawned.
 */
export function ensureUserShellPath(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;

  const extras: string[] = [];
  if (process.platform === 'darwin') {
    extras.push('/opt/homebrew/bin', '/opt/homebrew/sbin'); // Apple Silicon
    extras.push('/usr/local/bin', '/usr/local/sbin');       // Intel
    extras.push('/opt/local/bin', '/opt/local/sbin');       // MacPorts
  } else {
    extras.push('/usr/local/bin', '/usr/local/sbin');
    extras.push('/snap/bin');                                // Ubuntu Snap
  }
  // User-scoped binaries (pipx, cargo, npm -g) should also be visible.
  const home = process.env['HOME'];
  if (home) {
    extras.push(`${home}/.local/bin`, `${home}/bin`);
    // macOS `pip3 install --user` lands here. Cover the LTS Python versions
    // so a `pip install --user piper-tts` is automatically discoverable.
    if (process.platform === 'darwin') {
      for (const v of ['3.14', '3.13', '3.12', '3.11', '3.10']) {
        extras.push(`${home}/Library/Python/${v}/bin`);
      }
    }
  }

  const existing = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const p of [...extras, ...existing]) {
    if (!seen.has(p)) {
      seen.add(p);
      merged.push(p);
    }
  }
  process.env['PATH'] = merged.join(':');
}
