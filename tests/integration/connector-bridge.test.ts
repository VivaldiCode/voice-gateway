/**
 * Issue #14 (B1 follow-up): end-to-end connector → bridge → adapter loop.
 *
 * Boots the real `hermes-voice-bridge` Python aiohttp server in-process
 * (via `tests/integration/__helpers__/bridge_test_server.py`) with a
 * scripted adapter, then drives it through the real desktop-side
 * `HermesClient`. Catches any wire-protocol drift between the two
 * codebases that mocks on either side would silently paper over.
 *
 * Scenarios (one per scripted adapter mode):
 *   - happy           — handshake + 3 deltas + response_end
 *   - silent-crash    — adapter raises before any yield → client sees error
 *   - upstream-hang   — adapter parks forever → client sees HERMES_UPSTREAM
 *                       after the bridge's wall-clock timeout (monkey-patched
 *                       to 1 s in the helper)
 *   - empty-response  — adapter yields nothing → client sees HERMES_UPSTREAM
 *                       ("Hermes respondeu mas sem texto.")
 *
 * Skipped automatically when no Python on PATH has `aiohttp` importable
 * (the helper script needs it) — keeps vitest green
 * on environments where the dev hasn't installed Python (e.g. Node-only
 * Linux CI).
 */
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HermesClient } from '@main/services/hermes-client';
import type { MsgError, MsgResponseText, MsgWelcome } from '@shared/protocol';

// ESM-safe equivalent of __dirname. The project is `"type": "module"` so
// the CJS `__dirname` global is only available when the loader happens to
// shim it — using `import.meta.url` keeps this stable across loaders.
const HERE = dirname(fileURLToPath(import.meta.url));

const HELPER = join(HERE, '__helpers__', 'bridge_test_server.py');

// Picked once per test file. Windows shells expose Python as `py` or
// `python` rather than `python3`; the helper is the same either way.
//
// Issue #28: the previous version returned the first Python found on
// PATH, but the helper script (`tests/integration/__helpers__/
// bridge_test_server.py`) imports `aiohttp` to boot the bridge. On CI
// runners where Python is present but `aiohttp` isn't (the vitest job
// is Node-only — no `pip install` — and the Ubuntu 24.04 image now
// ships python3), the helper crashed on import with exit code 1 and
// the 4 scenarios reported `bridge helper (X) exited prematurely
// code=1`. Probing `import aiohttp` here treats "Python with the
// bridge deps installed" as the actual requirement and falls through
// to the next candidate (or `null`) otherwise, so the existing
// `PYTHON_BIN === null` skip-gate covers both old and new cases.
function resolvePythonBin(): string | null {
  for (const bin of ['python3', 'python', 'py']) {
    try {
      const version = spawnSync(bin, ['--version'], { stdio: 'ignore' });
      if (version.status !== 0) continue;
      // Cheap proxy for "this Python has the bridge deps". aiohttp is
      // the heaviest dep the helper imports; if it's there the rest
      // (`hermes_voice_bridge.config` via sys.path injection) tend to
      // resolve too. Failure-tolerant — falls through to the next
      // candidate on PATH so a venv'd Python further down the list
      // can still satisfy the gate.
      const aiohttp = spawnSync(bin, ['-c', 'import aiohttp'], { stdio: 'ignore' });
      if (aiohttp.status === 0) return bin;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const PYTHON_BIN = resolvePythonBin();

interface BootedBridge {
  url: string;
  token: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
}

/**
 * Spawn the helper Python script with the given scenario; resolve once
 * the script prints its LISTENING line. Rejects after 8 s.
 *
 * The premature-exit and timeout listeners are detached on success so a
 * normal SIGTERM from afterEach doesn't fire reject() on an already-
 * resolved promise (harmless, but trips the unhandled-rejection guard
 * on some setups).
 */
async function bootBridge(mode: string): Promise<BootedBridge> {
  if (!PYTHON_BIN) {
    throw new Error('python binary missing — should have been skipped');
  }
  if (!existsSync(HELPER)) {
    throw new Error(`helper script missing: ${HELPER}`);
  }
  const proc = spawn(PYTHON_BIN, [HELPER], {
    env: { ...process.env, VG_BRIDGE_TEST_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;

  if (process.env['VG_BRIDGE_TEST_VERBOSE'] === '1') {
    proc.stderr.on('data', (b: Buffer) => process.stderr.write(`[bridge:${mode}] ${b}`));
  }

  return await new Promise<BootedBridge>((resolve, reject) => {
    let settled = false;
    const onTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      proc.kill('SIGKILL');
      reject(new Error(`bridge helper (${mode}) did not announce LISTENING in 8 s`));
    }, 8_000);

    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf-8');
      // Accumulate until at least one full line — split, scan, and keep
      // the last (possibly partial) fragment in `buf` for the next event.
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      const line = lines.find((l) => l.startsWith('LISTENING '));
      if (!line) return;
      const m = /port=(\d+) token=(\S+)/.exec(line);
      if (!m) return;
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        url: `ws://127.0.0.1:${m[1]}/ws`,
        token: m[2] ?? '',
        proc,
      });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`bridge helper (${mode}) exited prematurely code=${code} signal=${signal}`));
    };
    const cleanup = (): void => {
      clearTimeout(onTimeout);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
    };
    proc.stdout.on('data', onData);
    proc.on('exit', onExit);
  });
}

const SKIP = PYTHON_BIN === null;

describe.skipIf(SKIP)('connector → bridge integration (issue #14)', () => {
  // The helper imports from `server/hermes-voice-bridge/src/` via a
  // sys.path injection, so we don't need to `pip install -e .` first.
  let bridge: BootedBridge | null = null;
  let client: HermesClient | null = null;

  afterEach(async () => {
    try {
      client?.disconnect();
    } catch {
      // ignore
    }
    client = null;
    if (bridge && bridge.proc.exitCode === null && bridge.proc.signalCode === null) {
      const proc = bridge.proc;
      const exited = new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve();
          return;
        }
        proc.once('exit', () => resolve());
      });
      proc.kill('SIGTERM');
      // Give SIGTERM 500ms then escalate. Wait at most 1.5 s so a wedged
      // helper can't hang the whole suite.
      const escalate = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, 500);
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      await Promise.race([exited, timeout]);
      clearTimeout(escalate);
    }
    bridge = null;
  });

  it('happy path: handshake + deltas + response_end', async () => {
    bridge = await bootBridge('happy');
    client = new HermesClient();

    const welcome = await new Promise<MsgWelcome>((resolve) => {
      client!.once('welcome', (m) => resolve(m as MsgWelcome));
      client!.connect({ url: bridge!.url, token: bridge!.token });
    });
    expect(welcome.type).toBe('welcome');

    // Send a transcript and collect text frames + the response_end.
    const deltas: string[] = [];
    let sawEnd = false;
    client.on('response_text', (m) => {
      deltas.push((m as MsgResponseText).text);
    });
    client.on('response_end', () => {
      sawEnd = true;
    });

    client.sendStartTurn('t-happy', 'pt');
    client.sendClientTranscript('t-happy', 'olá', true);
    client.sendEndTurn('t-happy');

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no response_end in 5 s')), 5_000);
      const tick = (): void => {
        if (sawEnd) {
          clearTimeout(t);
          resolve();
        } else {
          setTimeout(tick, 30);
        }
      };
      tick();
    });

    // Streaming deltas (3 from the scripted adapter) + 1 final aggregated.
    // We assert the assembled text contains the scripted payload regardless
    // of how the bridge bundles them.
    const combined = deltas.join('');
    expect(combined).toContain('olá');
    expect(combined).toContain('humano');
  }, 15_000);

  it('silent task crash: client sees an error frame (no infinite THINKING)', async () => {
    bridge = await bootBridge('silent-crash');
    client = new HermesClient();
    await new Promise<void>((resolve) => {
      client!.once('welcome', () => resolve());
      client!.connect({ url: bridge!.url, token: bridge!.token });
    });

    const err = await new Promise<MsgError>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no error frame in 5 s')), 5_000);
      client!.once('error', (m) => {
        clearTimeout(t);
        resolve(m as MsgError);
      });
      client!.sendStartTurn('t-crash');
      client!.sendClientTranscript('t-crash', 'olá', true);
      client!.sendEndTurn('t-crash');
    });
    expect(err.type).toBe('error');
    expect(err.message).toMatch(/RuntimeError|simulated|UNKNOWN/i);
  }, 15_000);

  it('upstream hang: client sees HERMES_UPSTREAM after wall-clock timeout', async () => {
    bridge = await bootBridge('upstream-hang');
    client = new HermesClient();
    await new Promise<void>((resolve) => {
      client!.once('welcome', () => resolve());
      client!.connect({ url: bridge!.url, token: bridge!.token });
    });

    const err = await new Promise<MsgError>((resolve, reject) => {
      // 1 s wall-clock + 2 s grace
      const t = setTimeout(() => reject(new Error('no error frame in 4 s')), 4_000);
      client!.once('error', (m) => {
        clearTimeout(t);
        resolve(m as MsgError);
      });
      client!.sendStartTurn('t-hang');
      client!.sendClientTranscript('t-hang', 'olá', true);
      client!.sendEndTurn('t-hang');
    });
    expect(err.code).toBe('HERMES_UPSTREAM');
    expect(err.message).toMatch(/1s|pendurado|upstream/i);
  }, 15_000);

  it('empty response: bridge surfaces HERMES_UPSTREAM with helpful copy', async () => {
    bridge = await bootBridge('empty-response');
    client = new HermesClient();
    await new Promise<void>((resolve) => {
      client!.once('welcome', () => resolve());
      client!.connect({ url: bridge!.url, token: bridge!.token });
    });

    const err = await new Promise<MsgError>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no error frame in 5 s')), 5_000);
      client!.once('error', (m) => {
        clearTimeout(t);
        resolve(m as MsgError);
      });
      client!.sendStartTurn('t-empty');
      client!.sendClientTranscript('t-empty', 'olá', true);
      client!.sendEndTurn('t-empty');
    });
    expect(err.code).toBe('HERMES_UPSTREAM');
    expect(err.message).toMatch(/sem texto|modelo|agent/i);
  }, 15_000);
});
