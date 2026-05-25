import type { Dictionary } from './pt';

/**
 * English (en-US) string catalogue. Same shape as `pt` — the
 * `Dictionary` type forces the keys to line up so a missing
 * translation fails at compile time, not at render time.
 */
export const en: Dictionary = {
  app: {
    settingsAria: 'Settings',
    muteOn: 'Voice muted — click to unmute',
    muteOff: 'Mute Hermes voice',
    muteTitleOn: 'Voice muted',
    muteTitleOff: 'Mute voice',
  },
  state: {
    IDLE: 'Ready',
    LISTENING_WAKE: 'Listening',
    CAPTURING: 'Capturing',
    STREAMING: 'Transcribing',
    THINKING: 'Thinking',
    SPEAKING: 'Speaking',
    ERROR: 'Error',
  },
  disabledReason: {
    micDenied: 'No microphone permission — open System Settings',
    micRestricted: 'Microphone restricted by system policy',
    micPending: 'Requesting microphone permission…',
    noConnection: 'No connection to Hermes',
    sttPreparing: 'Speech recognition preparing…',
    sttError: 'Speech recognition error — see Settings',
    sttNotReady: 'Speech recognition not ready yet',
    ttsError: 'Voice error — see Settings',
  },
  transcript: {
    emptyPtt: 'Press the button or use the shortcut to start.',
    emptyWake: 'Say the wake word or use the shortcut to start.',
    copy: 'copy',
    clear: 'clear',
    nMessages: (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`,
  },
  errorToast: {
    retry: 'Try again',
    copyDiag: 'Copy diagnostic',
  },
  settings: {
    language: 'Language',
    languagePt: 'Português',
    languageEn: 'English',
    aboutSection: 'About',
  },
};
