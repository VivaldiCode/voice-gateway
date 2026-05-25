import type { LanguageCode, WakeWord, WhisperModel } from './constants';

export type ActivationMode = 'PUSH_TO_TALK' | 'WAKE_WORD';

export type SttProvider = 'whisper_local' | 'openai_whisper';
export type TtsProvider = 'piper_local' | 'elevenlabs';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionInfo {
  status: ConnectionStatus;
  url: string | null;
  latencyMs: number | null;
  sessionId: string | null;
  lastError: string | null;
}

export interface PairingInfo {
  /** ws:// or wss:// URL of the bridge. */
  url: string;
  /** Bearer token from the install.sh output. */
  token: string;
}

export interface VoiceOption {
  id: string;
  label: string;
  language: LanguageCode | string;
  provider: TtsProvider;
}

export interface PiperVoiceConfig {
  modelId: string;
}

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

export interface TtsSettings {
  provider: TtsProvider;
  piper: PiperVoiceConfig;
  elevenlabs: ElevenLabsConfig;
}

export interface OpenAiSttConfig {
  apiKey: string;
  model: string;
}

export interface WhisperLocalConfig {
  model: WhisperModel;
}

export interface SttSettings {
  provider: SttProvider;
  language: LanguageCode | 'auto';
  whisperLocal: WhisperLocalConfig;
  openai: OpenAiSttConfig;
}

/**
 * Where the wake detection happens.
 *
 * - 'openww' — openWakeWord predefined models (low CPU, fixed phrase list).
 * - 'phrase' — streaming whisper.cpp over rolling windows looking for an
 *   arbitrary user-typed phrase. Higher CPU but works for "hey claude" or
 *   any custom wake word the user wants.
 */
export type WakeMode = 'openww' | 'phrase';

export interface ActivationSettings {
  mode: ActivationMode;
  wakeWord: WakeWord;
  /** See {@link WakeMode}. */
  wakeMode: WakeMode;
  /**
   * Custom phrase used when `wakeMode === 'phrase'`. Plain text; the matcher
   * normalises whitespace, casing, and punctuation. Example: "hey hermes".
   */
  wakePhrase: string;
  globalHotkey: string;
  vadThreshold: number;
  vadSilenceMs: number;
  /**
   * Minimum captured audio duration in milliseconds before we send to STT.
   * Anything shorter is treated as an accidental tap and we silently return
   * to IDLE with a friendly warning. Prevents OpenAI/Whisper from rejecting
   * <100ms clips, and stops accidental double-clicks from spamming
   * transcription.
   */
  minAudioMs: number;
}

export interface AudioSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  /**
   * When true, the renderer's `AudioPlayback` silently drops every TTS chunk
   * for the current and future turns. The conversation FSM still advances
   * (THINKING → SPEAKING → IDLE) — only the audio output is suppressed. The
   * user toggles this from the header speaker icon. Default `false`.
   */
  outputMuted: boolean;
}

export interface UiSettings {
  language: LanguageCode;
  theme: 'dark' | 'light' | 'system';
  startMinimized: boolean;
  /**
   * When true, the app registers itself as a macOS login item / Windows
   * startup app via `app.setLoginItemSettings({ openAtLogin: true })`. When
   * false the entry is removed. The setting is persisted; main reconciles
   * the OS state on every change so the toggle is durable across launches.
   */
  autoLaunch: boolean;
  /**
   * True once the user has seen the post-pair interactive tutorial OR
   * explicitly skipped it. The tutorial never auto-plays again. Reset
   * via Settings → Avançado → "Mostrar tutorial outra vez" (round-12 I5).
   */
  tutorialSeen: boolean;
}

/**
 * Connection-level history & in-flight drafts. Kept separate from the
 * "live" pairing so we can suggest recent URLs without leaking the
 * current token.
 */
export interface ConnectionSettings {
  /**
   * Most-recently-paired bridge URLs, newest first. Capped at
   * MAX_RECENT_BRIDGE_URLS. Surfaced as a `<datalist>` in the wizard's
   * step-1 URL input.
   */
  recentUrls: string[];
  /**
   * If the user typed a URL in the wizard but didn't finish pairing,
   * we remember it here so the next launch resumes where they left off.
   * Cleared on pair success.
   */
  draftUrl: string;
}

/**
 * Per-turn entry persisted so the user doesn't lose context across an
 * app restart. Only the visible role + text are stored — we explicitly
 * do NOT persist any audio payload (the TTS chunks would balloon the
 * settings file and there's no use case for replaying them).
 */
export interface PersistedTranscriptLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Unix-ms timestamp the line was first appended. Optional for v5+. */
  ts?: number;
}

export interface TranscriptHistorySettings {
  /** Newest-last list. Capped at MAX_PERSISTED_TRANSCRIPT_LINES. */
  recent: PersistedTranscriptLine[];
}

export interface Settings {
  pairing: PairingInfo | null;
  activation: ActivationSettings;
  stt: SttSettings;
  tts: TtsSettings;
  audio: AudioSettings;
  ui: UiSettings;
  /** Pairing draft + recent-URL history. v4 schema. */
  connection: ConnectionSettings;
  /** Persisted transcript window. v5 schema. */
  transcript: TranscriptHistorySettings;
  /** Bumped when the schema changes. Used by the store for migrations. */
  schemaVersion: number;
}

export interface AudioDeviceInfo {
  id: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
  isDefault: boolean;
}

export interface TranscriptTurn {
  id: string;
  startedAt: number;
  endedAt: number | null;
  userText: string;
  assistantText: string;
}
