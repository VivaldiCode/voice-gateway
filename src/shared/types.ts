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
}

export interface Settings {
  pairing: PairingInfo | null;
  activation: ActivationSettings;
  stt: SttSettings;
  tts: TtsSettings;
  audio: AudioSettings;
  ui: UiSettings;
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
