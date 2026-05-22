/**
 * Constants shared between main, preload, and renderer.
 * No runtime-side-effect imports here — must be safe in any process.
 */

export const APP_NAME = 'Voice Gateway';
export const APP_PROTOCOL = 'hermes';
export const CLIENT_VERSION = '0.1.0';

export const DEFAULT_BRIDGE_PORT = 8765;
export const DEFAULT_HERMES_URL = `ws://localhost:${DEFAULT_BRIDGE_PORT}`;

export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_FRAME_MS = 20;
export const AUDIO_FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * AUDIO_FRAME_MS) / 1000;

export const TTS_OUTPUT_SAMPLE_RATE = 24_000;

export const VAD_SILENCE_MS = 800;
export const VAD_MIN_SPEECH_MS = 200;
export const VAD_THRESHOLD_DEFAULT = 0.5;

export const WS_PING_INTERVAL_MS = 15_000;
export const WS_PONG_TIMEOUT_MS = 5_000;
export const WS_RECONNECT_BASE_MS = 500;
export const WS_RECONNECT_MAX_MS = 30_000;

export const DEFAULT_GLOBAL_HOTKEY_MAC = 'CommandOrControl+Shift+H';
export const DEFAULT_GLOBAL_HOTKEY_OTHER = 'Control+Shift+H';

export const SUPPORTED_WAKE_WORDS = [
  'hey_jarvis',
  'alexa',
  'hey_mycroft',
  'hey_rhasspy',
  'computer',
] as const;
export type WakeWord = (typeof SUPPORTED_WAKE_WORDS)[number];

export const SUPPORTED_LANGUAGES = ['pt', 'en'] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

export const SUPPORTED_WHISPER_MODELS = ['tiny', 'base', 'small'] as const;
export type WhisperModel = (typeof SUPPORTED_WHISPER_MODELS)[number];

export const IPC = {
  PING: 'vg:ping',
  SETTINGS_GET: 'vg:settings:get',
  SETTINGS_SET: 'vg:settings:set',
  SETTINGS_RESET: 'vg:settings:reset',
  SETTINGS_CHANGED: 'vg:settings:changed',
  PAIR_TEST: 'vg:pair:test',
  PAIR_SAVE: 'vg:pair:save',
  CONNECTION_STATUS: 'vg:connection:status',
  CONVERSATION_EVENT: 'vg:conversation:event',
  CONVERSATION_COMMAND: 'vg:conversation:command',
  AUDIO_DEVICES_LIST: 'vg:audio:devices',
  AUDIO_TEST_VOICE: 'vg:audio:test-voice',
  HOTKEY_TRIGGER: 'vg:hotkey:trigger',
  CONV_STATE: 'vg:conv:state',
  CONV_TRANSCRIPT: 'vg:conv:transcript',
  CONV_RESPONSE_TEXT: 'vg:conv:response-text',
  CONV_TTS_CHUNK: 'vg:conv:tts-chunk',
  CONV_ERROR: 'vg:conv:error',
  CONV_PTT_PRESS: 'vg:conv:ptt:press',
  CONV_PTT_RELEASE: 'vg:conv:ptt:release',
  CONV_AUDIO_FRAME: 'vg:conv:audio-frame',
  CONV_CANCEL: 'vg:conv:cancel',
  CONV_BARGE_IN: 'vg:conv:barge-in',
  CONV_RESET: 'vg:conv:reset',
  WAKE_DETECTED: 'vg:wake:detected',
  WAKE_STATUS: 'vg:wake:status',
  STT_PROGRESS: 'vg:stt:progress',
  STT_STATUS: 'vg:stt:status',
  TTS_PROGRESS: 'vg:tts:progress',
  TTS_LIST_VOICES: 'vg:tts:list-voices',
  TTS_TEST: 'vg:tts:test',
  AUDIO_TEST_TTS_CHUNK: 'vg:audio:test-tts-chunk',
  LOG: 'vg:log',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export const ERROR_CODES = {
  WS_DISCONNECTED: 'WS_DISCONNECTED',
  WS_AUTH_FAILED: 'WS_AUTH_FAILED',
  WS_INVALID_MESSAGE: 'WS_INVALID_MESSAGE',
  STT_FAILED: 'STT_FAILED',
  TTS_FAILED: 'TTS_FAILED',
  AUDIO_DEVICE_FAILED: 'AUDIO_DEVICE_FAILED',
  WAKE_WORD_FAILED: 'WAKE_WORD_FAILED',
  HERMES_UPSTREAM: 'HERMES_UPSTREAM',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
