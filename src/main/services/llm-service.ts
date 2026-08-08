/**
 * LLM service — provider abstraction for the multi-LLM integration.
 *
 * Scaffolds the contract that the conversation orchestrator will use when
 * `settings.llm.provider !== 'hermes-bridge'`. The actual HTTP clients
 * land in their own sub-issue commits on the same branch:
 *
 *   #57 — ClaudeAdapter (Anthropic Messages API)
 *   #58 — OllamaAdapter (local API + model discovery)
 *   #59 — GrokAdapter   (xAI API)
 *   #60 — ChatGptAdapter (OpenAI Chat Completions)
 *
 * Until each lands, the corresponding stub adapter throws a friendly
 * "not implemented yet" error from `complete()`. The factory still wires
 * the provider so the rest of the code (settings, IPC, UI scaffold) can
 * build against the real interface.
 *
 * Parent: issue #55. This file = sub-issue #56.
 */
import { EventEmitter } from 'node:events';
import type { LlmProvider, LlmSettings } from '@shared/types';

/** A single user/assistant message in the chat history. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Input to a single completion call. */
export interface LlmRequest {
  messages: LlmMessage[];
  /** Optional override; adapters fall back to their default if undefined. */
  model?: string;
  /** Optional per-request timeout override (ms). */
  timeoutMs?: number;
}

/** A streamed delta from the LLM. `done=true` marks the final chunk. */
export interface LlmChunk {
  /** Token / chunk text appended to the response. Empty on the terminal chunk. */
  delta: string;
  /** True only on the last chunk of the stream. */
  done: boolean;
  /** Optional model id the provider echoed back (Anthropic / xAI / OpenAI). */
  model?: string;
}

/**
 * Provider-side progress signals used during `prepare()` (e.g. Ollama's
 * `/api/tags` probe, or a future "warm the model" call).
 */
export interface LlmProgressEvent {
  stage: 'probing' | 'ready' | 'error';
  /** 0..1 if the adapter can measure it, otherwise null. */
  fraction: number | null;
  detail?: string;
}

/** The contract every concrete provider implements. */
export interface LlmAdapter extends EventEmitter {
  /** Stable identifier — matches `LlmProvider` for the concrete providers. */
  readonly id: LlmProvider;
  /**
   * Cheap synchronous check. False = `complete()` would fail right now
   * (missing key, daemon down, etc.). True = at least the precondition is
   * met; network errors can still happen.
   */
  isReady(): boolean;
  /**
   * Optional one-shot warm-up (e.g. probe Ollama's `/api/tags`). Resolves
   * once the adapter is reporting `isReady() === true`. Adapters that don't
   * need a probe can omit this method.
   */
  prepare?(onProgress?: (e: LlmProgressEvent) => void): Promise<void>;
  /**
   * Run a completion. Returns an async iterable of chunks; the consumer
   * is responsible for piping them into the TTS adapter.
   *
   * Errors surface as a rejection on the iterator OR as the iterable
   * throwing. Either way the conversation orchestrator translates them
   * into the existing `'error'` event shape so the renderer doesn't have
   * to learn a new error type.
   */
  complete(req: LlmRequest): AsyncIterable<LlmChunk>;
}

export interface CreateLlmAdapterOptions {
  /** Override `fetch` for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Override the per-provider timeout default (ms). Reads
   * `process.env.VG_LLM_TIMEOUT_MS` first, then falls back to the
   * per-adapter constant.
   */
  defaultTimeoutMs?: number;
}

/**
 * Factory. Returns `null` for the special `'hermes-bridge'` provider —
 * the orchestrator interprets `null` as "use the bridge", which keeps the
 * v6 behavior bit-for-bit. For every other provider, returns the
 * matching adapter (currently a stub that throws on `complete()` until
 * the per-provider sub-issue lands).
 */
export function createLlmAdapter(
  settings: LlmSettings,
  _opts: CreateLlmAdapterOptions = {},
): LlmAdapter | null {
  switch (settings.provider) {
    case 'hermes-bridge':
      return null;
    case 'claude':
      return new StubAdapter('claude', 57);
    case 'ollama':
      return new StubAdapter('ollama', 58);
    case 'grok':
      return new StubAdapter('grok', 59);
    case 'chatgpt':
      return new StubAdapter('chatgpt', 60);
    default: {
      // Exhaustiveness check — TypeScript will flag the day a new
      // provider is added without updating this switch.
      const exhaustive: never = settings.provider;
      throw new Error(`createLlmAdapter: unknown provider ${String(exhaustive)}`);
    }
  }
}

/**
 * Placeholder adapter. Tracks the per-provider implementation issue so
 * an in-flight orchestrator wired to the wrong provider gets a clear
 * "this provider isn't shipped yet" message instead of a confusing crash.
 *
 * Replaced by the real implementation in each provider's sub-issue commit
 * on the same branch (#57–#60).
 */
class StubAdapter extends EventEmitter implements LlmAdapter {
  readonly id: LlmProvider;
  private readonly trackingIssue: number;

  constructor(id: Exclude<LlmProvider, 'hermes-bridge'>, trackingIssue: number) {
    super();
    this.id = id;
    this.trackingIssue = trackingIssue;
  }

  isReady(): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *complete(_req: LlmRequest): AsyncIterable<LlmChunk> {
    throw new Error(
      `LLM provider '${this.id}' is not yet implemented — tracking in issue #${this.trackingIssue}.`,
    );
    // Unreachable, but the yield statement keeps TS happy about the
    // AsyncGenerator return type (the function must contain a yield).
    // eslint-disable-next-line no-unreachable
    yield { delta: '', done: true };
  }
}

// Re-exported for tests that want to verify the stub's behavior.
export { StubAdapter as _StubAdapter };
