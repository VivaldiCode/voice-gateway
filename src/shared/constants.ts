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

/**
 * Maximum number of bridge URLs we keep around for the wizard's
 * suggestion dropdown. Smaller than typical "recent files" lists
 * because most users only ever pair with 1–2 bridges.
 */
export const MAX_RECENT_BRIDGE_URLS = 3;

/**
 * How many transcript lines to persist to settings between launches.
 * Sized so the settings file stays small even for chatty users — at
 * ~200 bytes per line that's ~4 KB.
 */
export const MAX_PERSISTED_TRANSCRIPT_LINES = 20;

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

// LLM defaults — used by `defaultSettings()` and the wizard / Settings
// pickers. The list is curated (not exhaustive): picking the wrong model
// name returns a confusing 404 from the provider, so the picker UI shows
// only these IDs. Each adapter validates against this list at request time.
// Bumped per provider's sub-issue (#57–#60); orchestrator routing in #62.
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';
export const DEFAULT_GROK_MODEL = 'grok-4';
export const DEFAULT_CHATGPT_MODEL = 'gpt-4o-mini';
/** Conversation-history window (in user/assistant turn pairs) sent to the LLM by default. */
export const DEFAULT_LLM_HISTORY_TURNS = 10;

export const IPC = {
  PING: 'vg:ping',
  SETTINGS_GET: 'vg:settings:get',
  SETTINGS_SET: 'vg:settings:set',
  SETTINGS_RESET: 'vg:settings:reset',
  SETTINGS_CHANGED: 'vg:settings:changed',
  SETTINGS_OPEN_WINDOW: 'vg:settings:open-window',
  PAIR_TEST: 'vg:pair:test',
  PAIR_SAVE: 'vg:pair:save',
  CONNECTION_STATUS: 'vg:connection:status',
  /** Sync getter — the renderer asks for the current snapshot on mount so it
   *  doesn't have to wait up to 15 s for the next heartbeat-driven event. */
  CONNECTION_STATUS_GET: 'vg:connection:status:get',
  /** Renderer asks main to force a reconnect now (e.g. user clicks the
   *  connection indicator). No-op if already connected or no pairing. */
  CONNECTION_RECONNECT_NOW: 'vg:connection:reconnect-now',
  CONVERSATION_EVENT: 'vg:conversation:event',
  CONVERSATION_COMMAND: 'vg:conversation:command',
  AUDIO_DEVICES_LIST: 'vg:audio:devices',
  AUDIO_TEST_VOICE: 'vg:audio:test-voice',
  AUDIO_MIC_STATUS: 'vg:audio:mic-status',
  AUDIO_MIC_REQUEST: 'vg:audio:mic-request',
  AUDIO_OPEN_MIC_SETTINGS: 'vg:audio:open-mic-settings',
  HOTKEY_TRIGGER: 'vg:hotkey:trigger',
  CONV_STATE: 'vg:conv:state',
  CONV_TRANSCRIPT: 'vg:conv:transcript',
  CONV_RESPONSE_TEXT: 'vg:conv:response-text',
  CONV_TTS_CHUNK: 'vg:conv:tts-chunk',
  CONV_ERROR: 'vg:conv:error',
  CONV_WARNING: 'vg:conv:warning',
  CONV_PTT_PRESS: 'vg:conv:ptt:press',
  CONV_PTT_RELEASE: 'vg:conv:ptt:release',
  CONV_AUDIO_FRAME: 'vg:conv:audio-frame',
  CONV_CANCEL: 'vg:conv:cancel',
  CONV_BARGE_IN: 'vg:conv:barge-in',
  CONV_RESET: 'vg:conv:reset',
  WAKE_DETECTED: 'vg:wake:detected',
  WAKE_STATUS: 'vg:wake:status',
  /** Renderer asks main to spin up a sandboxed wake-word runner for the
   *  Settings → Ativação "Testar" button. */
  WAKE_TEST_START: 'vg:wake:test:start',
  /** Renderer asks main to kill the test runner. */
  WAKE_TEST_STOP: 'vg:wake:test:stop',
  /** Main pushes events from the test runner back to the renderer. */
  WAKE_TEST_EVENT: 'vg:wake:test:event',
  STT_PROGRESS: 'vg:stt:progress',
  STT_STATUS: 'vg:stt:status',
  STT_PREPARE: 'vg:stt:prepare',
  TTS_PROGRESS: 'vg:tts:progress',
  TTS_STATUS: 'vg:tts:status',
  TTS_LIST_VOICES: 'vg:tts:list-voices',
  TTS_PREPARE: 'vg:tts:prepare',
  TTS_TEST: 'vg:tts:test',
  AUDIO_TEST_TTS_CHUNK: 'vg:audio:test-tts-chunk',
  LOG: 'vg:log',
  /** Renderer asks main to surface the electron-log file in Finder/Explorer.
   *  Returns the absolute path so the renderer can also display it. */
  LOG_REVEAL_FILE: 'vg:log:reveal-file',
  /** Renderer asks for the last N lines of the electron-log file. Used by
   *  the live log preview in Settings → Avançado (polled every ~1s).
   *  Read-only — never throws even if the file isn't there yet. */
  LOG_READ_TAIL: 'vg:log:read-tail',
  /** Renderer hands the formatted transcript text to main; main opens a
   *  Save dialog and writes it. Returns { ok, path? } so the renderer can
   *  show a quick confirmation toast. */
  TRANSCRIPT_EXPORT: 'vg:transcript:export',
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
