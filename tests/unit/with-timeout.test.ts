import { describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from '@shared/with-timeout';

describe('withTimeout', () => {
  it('resolves with the original value when the promise wins the race', async () => {
    const result = await withTimeout(Promise.resolve(42), { ms: 1_000 });
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when the deadline expires first', async () => {
    // Injected setTimer fires synchronously so the test doesn't waste real
    // wall-clock seconds.
    const setTimer = vi.fn((cb: () => void) => {
      queueMicrotask(cb);
      return 1;
    });
    const clearTimer = vi.fn();
    const never = new Promise<number>(() => undefined); // forever-pending
    await expect(
      withTimeout(never, { ms: 1_000, label: 'whisper', setTimer, clearTimer }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('the TimeoutError message includes the configured label', async () => {
    const setTimer = vi.fn((cb: () => void) => {
      queueMicrotask(cb);
      return 1;
    });
    try {
      await withTimeout(new Promise<void>(() => undefined), {
        ms: 250,
        label: 'piper',
        setTimer,
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as Error).message).toMatch(/piper/);
      expect((err as Error).message).toMatch(/250/);
    }
  });

  it('does not invoke the resolve path after the timeout already fired', async () => {
    let immediateFires = 0;
    const setTimer = vi.fn((cb: () => void) => {
      queueMicrotask(cb);
      return 1;
    });
    let resolveLate: ((v: number) => void) = () => undefined;
    const promise = new Promise<number>((res) => {
      resolveLate = res;
    });
    const racePromise = withTimeout(promise, { ms: 100, setTimer });
    await racePromise.catch(() => {
      immediateFires += 1;
    });
    // Resolve AFTER the timeout already fired. Should not throw or
    // double-emit.
    resolveLate(99);
    await new Promise((r) => setImmediate(r));
    expect(immediateFires).toBe(1);
  });

  it('clears the scheduled timer on early success (no leak)', async () => {
    const handle = Symbol('handle');
    const setTimer = vi.fn(() => handle);
    const clearTimer = vi.fn();
    await withTimeout(Promise.resolve('ok'), { ms: 1_000, setTimer, clearTimer });
    expect(clearTimer).toHaveBeenCalledWith(handle);
  });

  it('clears the scheduled timer on early rejection', async () => {
    const handle = Symbol('handle');
    const setTimer = vi.fn(() => handle);
    const clearTimer = vi.fn();
    await expect(
      withTimeout(Promise.reject(new Error('boom')), { ms: 1_000, setTimer, clearTimer }),
    ).rejects.toThrow(/boom/);
    expect(clearTimer).toHaveBeenCalledWith(handle);
  });

  it('propagates the original rejection unchanged (not wrapped in TimeoutError)', async () => {
    const orig = new Error('original');
    await expect(
      withTimeout(Promise.reject(orig), { ms: 1_000 }),
    ).rejects.toBe(orig);
  });

  it('TimeoutError exposes a stable `code` for cross-process handling', async () => {
    const setTimer = vi.fn((cb: () => void) => {
      queueMicrotask(cb);
      return 1;
    });
    try {
      await withTimeout(new Promise(() => undefined), { ms: 1, setTimer });
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).code).toBe('TIMEOUT');
    }
  });
});
