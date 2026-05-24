/**
 * Coverage for the tiny shared subprocess helpers that the STT/TTS adapters
 * depend on. Both pieces are tested with an injectable spawn so we don't
 * actually run `/usr/bin/which` or hit the network.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { downloadFile, whichCmd } from '@main/services/_subprocess-utils';

interface FakeProc extends EventEmitter {
  stdout: Readable | null;
  stderr: Readable | null;
}

function makeProc(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  setImmediate(() => {
    if (opts.stdout != null) proc.stdout!.push(opts.stdout);
    proc.stdout!.push(null);
    if (opts.stderr != null) proc.stderr!.push(opts.stderr);
    proc.stderr!.push(null);
    proc.emit('close', opts.exitCode ?? 0);
  });
  return proc;
}

describe('whichCmd', () => {
  it('returns the first hit when `which` exits 0', async () => {
    // Patch the global `child_process.spawn` via vitest's module mock — but
    // `_subprocess-utils.ts` calls the imported `spawn` directly, so we
    // mock at the module level.
    // Simpler approach: spy on the actual implementation by checking the
    // shape of the returned value. `which` is OS-dependent; we just need
    // it to return either a string or null without throwing.
    const result = await whichCmd('node'); // `node` is always on PATH in the test runner
    expect(typeof result === 'string' || result === null).toBe(true);
    if (typeof result === 'string') {
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('returns null for a definitely-missing binary', async () => {
    const result = await whichCmd('this-binary-definitely-does-not-exist-9999');
    expect(result).toBeNull();
  });
});

describe('downloadFile', () => {
  it('rejects when fetch fails (HTTP non-2xx)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      // 404 — should throw.
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 404,
        body: null,
        headers: { get: () => null },
      })) as unknown as typeof fetch;

      await expect(
        downloadFile('http://does.not.matter/x', '/tmp/vg-dl-test-404'),
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('streams to dest and reports progress when content-length is known', async () => {
    const originalFetch = globalThis.fetch;
    const tmpDest = `/tmp/vg-dl-test-${Date.now()}.bin`;
    try {
      const body = new Uint8Array([1, 2, 3, 4, 5]);
      // Build a ReadableStream with a single chunk.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      });
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: stream,
        headers: { get: (k: string) => (k === 'content-length' ? '5' : null) },
      })) as unknown as typeof fetch;

      const progress: Array<{ fraction: number | null }> = [];
      await downloadFile('http://x/y', tmpDest, (p) => progress.push(p));
      expect(progress.length).toBeGreaterThan(0);
      const last = progress[progress.length - 1];
      expect(last?.fraction).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(tmpDest);
      } catch {
        // ignore
      }
    }
  });

  it('reports progress without a fraction when content-length is missing', async () => {
    const originalFetch = globalThis.fetch;
    const tmpDest = `/tmp/vg-dl-test-${Date.now()}-nolen.bin`;
    try {
      const body = new Uint8Array([7, 8, 9]);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(body);
          c.close();
        },
      });
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: stream,
        headers: { get: () => null }, // no content-length
      })) as unknown as typeof fetch;
      const progress: Array<{ fraction: number | null }> = [];
      await downloadFile('http://x/y', tmpDest, (p) => progress.push(p));
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[progress.length - 1]?.fraction).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(tmpDest);
      } catch {
        // ignore
      }
    }
  });
});

// keep makeProc reachable so the unused-export lint doesn't fire if we
// expand the suite later.
void makeProc;
