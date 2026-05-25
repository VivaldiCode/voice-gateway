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
 * Skipped automatically when python3 isn't on PATH — keeps vitest green
 * on environments where the dev hasn't installed Python (e.g. Node-only
 * Linux CI).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HermesClient } from '@main/services/hermes-client';
import type { MsgError, MsgResponseText, MsgWelcome } from '@shared/protocol';

const HELPER = join(
  __dirname,
  '__helpers__',
  'bridge_test_server.py',
);

interface BootedBridge {
  url: string;
  token: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
}

/**
 * Spawn the helper Python script with the given scenario; resolve once
 * the script prints its LISTENING line. Rejects after 8 s.
 */
async function bootBridge(mode: string): Promise<BootedBridge> {
  if (!existsSync(HELPER)) {
    throw new Error(`helper script missing: ${HELPER}`);
  }
  const proc = spawn('python3', [HELPER], {
    env: { ...process.env, VG_BRIDGE_TEST_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;

  if (process.env['VG_BRIDGE_TEST_VERBOSE'] === '1') {
    proc.stderr.on('data', (b: Buffer) => process.stderr.write(`[bridge:${mode}] ${b}`));
  }

  return await new Promise<BootedBridge>((resolve, reject) => {
    const onTimeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`bridge helper (${mode}) did not announce LISTENING in 8 s`));
    }, 8_000);

    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const line = buf.split('\n').find((l) => l.startsWith('LISTENING '));
      if (!line) return;
      const m = /port=(\d+) token=(\S+)/.exec(line);
      if (!m) return;
      clearTimeout(onTimeout);
      resolve({
        url: `ws://127.0.0.1:${m[1]}/ws`,
        token: m[2] ?? '',
        proc,
      });
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(onTimeout);
      reject(new Error(`bridge helper (${mode}) exited prematurely code=${code} signal=${signal}`));
    });
  });
}

function pythonAvailable(): boolean {
  try {
    const r = require('node:child_process').spawnSync('python3', ['--version'], {
      stdio: 'ignore',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

const SKIP = !pythonAvailable();

describe.skipIf(SKIP)('connector → bridge integration (issue #14)', () => {
  let bridge: BootedBridge | null = null;
  let client: HermesClient | null = null;

  beforeAll(() => {
    if (SKIP) return;
    // The helper imports from `server/hermes-voice-bridge/src/` via a
    // sys.path injection, so we don't need to `pip install -e .` first.
  });

  afterEach(async () => {
    try {
      client?.disconnect();
    } catch {
      // ignore
    }
    client = null;
    if (bridge) {
      bridge.proc.kill('SIGTERM');
      // best-effort wait — don't hold the suite past 1 s on a hung helper
      await new Promise((r) => setTimeout(r, 100));
      try {
        bridge.proc.kill('SIGKILL');
      } catch {
        // already dead
      }
      bridge = null;
    }
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
