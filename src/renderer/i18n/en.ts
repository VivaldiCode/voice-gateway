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
    windowTitle: (state) => `Voice Gateway — ${state}`,
    cancelCaptureAria: 'Cancel recording',
    notificationReply: 'Hermes replied',
    micPickerAria: 'Choose microphone',
    micPickerTitle: 'Microphone',
    speakerPickerAria: 'Choose audio output',
    speakerPickerTitle: 'Audio output',
    devicePickerDefault: 'System default',
    devicePickerNoLabels: 'Grant microphone permission to see device names.',
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
    nMessages: (n) => `${n} ${n === 1 ? 'message' : 'messages'}`,
    copyAria: 'Copy conversation',
    clearAria: 'Clear conversation',
    userPrefix: 'you',
    assistantPrefix: 'hermes',
    exportUser: 'You',
    exportAssistant: 'Hermes',
  },
  errorToast: {
    retry: 'Try again',
    copyDiag: 'Copy diagnostic',
  },
  micPermission: {
    deniedTitle: 'Voice Gateway needs microphone permission.',
    deniedBody:
      'Open System Settings to authorise the microphone — the call button only activates after.',
    pendingTitle: 'Microphone permission not yet confirmed.',
    pendingBody:
      'Click Request permission. If macOS already replied, the permission appears when you focus the window again.',
    request: 'Request permission',
    openSettings: 'Open System Settings',
  },
  hotkeyHint: {
    template: (wakeLabel) => `Press the button ${wakeLabel}.`,
    sayWakePhrase: (phrase) => `or say «${phrase}»`,
    orShortcut: (hotkey) => `or use ${hotkey}`,
  },
  connection: {
    connectedWithLatency: (ms) => (ms != null ? `Connected (${ms} ms)` : 'Connected'),
    connecting: 'Connecting…',
    connectingAttempt: (n) => `Connecting… (attempt ${n})`,
    disconnectedClick: 'Offline — click to retry',
    disconnectedAttempt: (n) => `Offline (attempt ${n}) — click to retry`,
    activeTitle: 'Connection active',
    retryTitle: 'Click to retry the connection',
  },
  tutorial: {
    welcomeTitle: 'Welcome to Voice Gateway 👋',
    welcomeBody:
      "In three screens I'll teach you the basics. Takes under 30 seconds and you can skip any time.",
    pressTitle: 'Press the button to talk',
    pressBody:
      'The big violet button in the centre is your microphone. Hold it while you speak and release when done — Hermes replies in seconds.',
    pressHint: 'Or use the global shortcut (set during pairing).',
    cancelTitle: 'X cancels mid-turn',
    cancelBody:
      'While you talk, a tiny "×" appears next to the mic. Click it (or hit Escape) to cancel the turn without sending anything.',
    cancelHint: 'Useful when you start saying the wrong thing.',
    settingsTitle: 'Everything else lives in Settings',
    settingsBody:
      'Voice, microphone, wake word, language, export conversation — all in one panel reached via ⚙. Cmd+, opens it directly.',
    settingsHint: 'Cmd+L clears the conversation · Cmd+S exports to file.',
    doneTitle: 'Done! Say hi to Hermes.',
    doneBody:
      'If you change your mind, you can reopen this tutorial in Settings → Advanced.',
    skip: 'Skip tutorial',
    back: '← Back',
    next: 'Next →',
    start: 'Start',
  },
  settings: {
    language: 'Language',
    languagePt: 'Português',
    languageEn: 'English',
    aboutSection: 'About',
  },
};
