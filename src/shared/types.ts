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

export interface ActivationSettings {
  mode: ActivationMode;
  wakeWord: WakeWord;
  globalHotkey: string;
  vadThreshold: number;
  vadSilenceMs: number;
}

export interface AudioSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
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
