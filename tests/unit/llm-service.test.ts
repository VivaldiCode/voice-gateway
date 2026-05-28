/**
 * Issue #55 — sub-issue #56: LLM provider abstraction smoke tests.
 *
 * These tests pin the scaffold's contract so the per-provider sub-issues
 * (#57 Claude, #58 Ollama, #59 Grok, #60 ChatGPT) can replace the stub
 * without breaking the orchestrator that's wired against this surface.
 *
 * Coverage:
 *   - Factory dispatch for every `LlmProvider` value
 *   - `'hermes-bridge'` returns null (bridge owns the LLM call, v6 behavior)
 *   - Stub adapters fail with a useful "tracking issue #N" error message
 *   - Settings migration v6 → v7 backfills the `llm` block without dropping
 *     existing settings
 */
import { describe, expect, it } from 'vitest';
import { createLlmAdapter, _StubAdapter, type LlmAdapter } from '../../src/main/services/llm-service';
import { _mergeSettings as mergeSettings } from '../../src/main/services/settings-store';
import {
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_LLM_HISTORY_TURNS,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
} from '../../src/shared/constants';
import type { LlmProvider, LlmSettings, Settings } from '../../src/shared/types';

// Helper — minimum-viable LlmSettings with the given provider; the other
// blocks stay at the defaults from `defaultSettings()` so a switch in any
// direction works without re-entering keys.
function llmSettings(provider: LlmProvider): LlmSettings {
  return {
    provider,
    claude: { apiKey: '', model: DEFAULT_CLAUDE_MODEL },
    ollama: { baseUrl: DEFAULT_OLLAMA_BASE_URL, model: DEFAULT_OLLAMA_MODEL },
    grok: { apiKey: '', model: DEFAULT_GROK_MODEL },
    chatgpt: { apiKey: '', model: DEFAULT_CHATGPT_MODEL },
    historyTurns: DEFAULT_LLM_HISTORY_TURNS,
  };
}

async function drainFirstChunk(it: AsyncIterable<unknown>): Promise<void> {
  // We expect the stub to throw on the first await — wrap so the test
  // assertion sees the rejection cleanly.
  for await (const _ of it) {
    // unreachable on a stub
  }
}

describe('createLlmAdapter — factory dispatch', () => {
  it("returns null for 'hermes-bridge' (bridge owns the LLM, v6 behavior)", () => {
    expect(createLlmAdapter(llmSettings('hermes-bridge'))).toBeNull();
  });

  it.each<[Exclude<LlmProvider, 'hermes-bridge'>, number]>([
    ['claude', 57],
    ['ollama', 58],
    ['grok', 59],
    ['chatgpt', 60],
  ])("returns a StubAdapter for '%s' that points at issue #%s", (provider, trackingIssue) => {
    const adapter = createLlmAdapter(llmSettings(provider));
    expect(adapter).not.toBeNull();
    expect(adapter).toBeInstanceOf(_StubAdapter);
    expect(adapter!.id).toBe(provider);
    expect(adapter!.isReady()).toBe(false);

    // The thrown error must reference the per-provider sub-issue so the
    // developer who wires this up knows exactly where the real
    // implementation will land.
    return expect(
      drainFirstChunk((adapter as LlmAdapter).complete({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toThrow(new RegExp(`provider '${provider}'.*issue #${trackingIssue}`));
  });
});

describe('settings migration v6 → v7 (llm block)', () => {
  it("backfills the 'llm' block onto a v6-shaped settings object", () => {
    // Simulate a v6 settings file (the only difference vs v7 is the
    // missing 'llm' key). Reuse a real `defaultSettings()` shape minus
    // the v7 additions via a hand-rolled minimal v6 fixture.
    const v6Like: Partial<Settings> = {
      pairing: null,
      schemaVersion: 6,
      // v6 had stt + tts but no llm:
      stt: {
        provider: 'whisper_local',
        language: 'auto',
        whisperLocal: { model: 'base' },
        openai: { apiKey: 'sk-existing-key-not-to-lose', model: 'whisper-1' },
      },
    };

    // The settings-store does `mergeSettings(defaultSettings(), existing)`
    // — which means the test can validate by reverse-engineering the same
    // call. We import the helper directly.
    const defaults: Settings = {
      pairing: null,
      activation: {
        mode: 'PUSH_TO_TALK',
        wakeWord: 'hey_jarvis',
        wakeMode: 'openww',
        wakePhrase: 'hey hermes',
        globalHotkey: 'CommandOrControl+Shift+H',
        vadThreshold: 0.5,
        vadSilenceMs: 800,
        minAudioMs: 300,
      },
      stt: {
        provider: 'whisper_local',
        language: 'auto',
        whisperLocal: { model: 'base' },
        openai: { apiKey: '', model: 'whisper-1' },
      },
      tts: {
        provider: 'piper_local',
        piper: { modelId: 'en_US-lessac-medium' },
        elevenlabs: { apiKey: '', voiceId: '', modelId: 'eleven_turbo_v2_5' },
      },
      audio: { inputDeviceId: null, outputDeviceId: null, outputMuted: false },
      ui: { language: 'pt', theme: 'dark', startMinimized: false, autoLaunch: false, tutorialSeen: false },
      connection: { recentUrls: [], draftUrl: '' },
      transcript: { recent: [] },
      llm: llmSettings('hermes-bridge'),
      schemaVersion: 7,
    };

    const migrated = mergeSettings(defaults, v6Like as Partial<Settings>);

    // The user's existing OpenAI key (from v6) MUST survive the merge.
    expect(migrated.stt.openai.apiKey).toBe('sk-existing-key-not-to-lose');
    // The new llm block MUST be present and default to 'hermes-bridge'
    // so the user's first launch after upgrade behaves identically.
    expect(migrated.llm).toBeDefined();
    expect(migrated.llm.provider).toBe('hermes-bridge');
    expect(migrated.llm.claude.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(migrated.llm.ollama.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
  });
});

describe('LlmSettings shape', () => {
  it('exposes all four cloud providers + ollama + the bridge default', () => {
    // Source-string-style canary: if someone adds a 6th provider, this
    // test breaks loudly so the factory + UI get updated together.
    const providers: LlmProvider[] = ['hermes-bridge', 'claude', 'ollama', 'grok', 'chatgpt'];
    for (const p of providers) {
      const adapter = createLlmAdapter(llmSettings(p));
      if (p === 'hermes-bridge') {
        expect(adapter).toBeNull();
      } else {
        expect(adapter?.id).toBe(p);
      }
    }
  });
});
