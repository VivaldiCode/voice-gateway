/**
 * Promise.race-based timeout wrapper used by the STT and TTS adapters.
 *
 * Pure: takes a promise + duration, returns a promise that either resolves
 * with the original value or rejects with a friendly Error after `ms`. No
 * cancellation of the underlying work — the wrapped promise keeps running
 * but its eventual settlement is discarded. Callers are expected to also
 * trigger their own cleanup (kill the subprocess, abort the fetch, etc.)
 * to actually free resources.
 *
 * No imports — safe in any Electron process and in unit tests.
 */

export interface WithTimeoutOptions {
  /** Cap in milliseconds. */
  ms: number;
  /** Used in the rejection message. e.g. `"whisper-cli"` or `"piper"`. */
  label?: string;
  /**
   * Injectable timer scheduler. Defaults to `setTimeout`. Tests pass a
   * fake (e.g. vi.fn(setTimeout)) so the timeout can be stepped without
   * `vi.useFakeTimers()` polluting the rest of the suite.
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Race `promise` against an `ms` timeout. Resolves with the promise's
 * value if it settles in time, rejects with a `TimeoutError` otherwise.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  opts: WithTimeoutOptions,
): Promise<T> {
  const { ms, label } = opts;
  const setTimer = opts.setTimer ?? ((cb: () => void, t: number) => setTimeout(cb, t));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handle = setTimer(() => {
      if (settled) return;
      settled = true;
      reject(
        new TimeoutError(
          label
            ? `${label} timed out after ${ms} ms`
            : `operation timed out after ${ms} ms`,
        ),
      );
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimer(handle);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimer(handle);
        reject(err);
      },
    );
  });
}
