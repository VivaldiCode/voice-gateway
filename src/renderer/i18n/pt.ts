/**
 * Shape of every locale dictionary. The `Dictionary` interface is what
 * the type checker compares against — values stay as plain `string` /
 * function so other locales can substitute different copy without
 * fighting the type system. Adding a new key here forces every locale
 * to provide its translation at compile time (TS error otherwise).
 */
export interface Dictionary {
  app: {
    settingsAria: string;
    muteOn: string;
    muteOff: string;
    muteTitleOn: string;
    muteTitleOff: string;
    /** Window title prefix — e.g. "Voice Gateway — {state}". */
    windowTitle: (state: string) => string;
    /** aria-label for the "X" button that aborts an in-flight capture. */
    cancelCaptureAria: string;
    /** Title of the desktop notification shown when an assistant reply
     *  lands while the window is unfocused/hidden. */
    notificationReply: string;
    /** aria-label + tooltip on the mic-picker icon button (issue #20). */
    micPickerAria: string;
    /** Heading inside the mic-picker popover. */
    micPickerTitle: string;
    /** aria-label + tooltip on the speaker-picker icon button. */
    speakerPickerAria: string;
    /** Heading inside the speaker-picker popover. */
    speakerPickerTitle: string;
    /** Pseudo-entry label for "fall back to the OS default device". */
    devicePickerDefault: string;
    /** Hint shown when device labels are missing (mic permission not
     *  granted yet — labels populate after permission). */
    devicePickerNoLabels: string;
  };
  state: {
    IDLE: string;
    LISTENING_WAKE: string;
    CAPTURING: string;
    STREAMING: string;
    THINKING: string;
    SPEAKING: string;
    ERROR: string;
  };
  disabledReason: {
    micDenied: string;
    micRestricted: string;
    micPending: string;
    noConnection: string;
    sttPreparing: string;
    sttError: string;
    sttNotReady: string;
    ttsError: string;
  };
  transcript: {
    emptyPtt: string;
    emptyWake: string;
    copy: string;
    clear: string;
    nMessages: (n: number) => string;
    /** aria-labels for the action-bar icon buttons. */
    copyAria: string;
    clearAria: string;
    /** Inline role chip rendered before each transcript line (lowercase). */
    userPrefix: string;
    assistantPrefix: string;
    /** Capitalised role prefix used when exporting / copying the conversation
     *  to plain text (Cmd+S, transcript-copy). */
    exportUser: string;
    exportAssistant: string;
  };
  errorToast: {
    retry: string;
    copyDiag: string;
  };
  micPermission: {
    deniedTitle: string;
    deniedBody: string;
    pendingTitle: string;
    pendingBody: string;
    request: string;
    openSettings: string;
  };
  hotkeyHint: {
    /** "Press the button {wakeLabel}." */
    template: (wakeLabel: string) => string;
    sayWakePhrase: (phrase: string) => string;
    orShortcut: (hotkey: string) => string;
  };
  connection: {
    connectedWithLatency: (ms: number | null) => string;
    connecting: string;
    connectingAttempt: (n: number) => string;
    disconnectedClick: string;
    disconnectedAttempt: (n: number) => string;
    activeTitle: string;
    retryTitle: string;
  };
  tutorial: {
    welcomeTitle: string;
    welcomeBody: string;
    pressTitle: string;
    pressBody: string;
    pressHint: string;
    cancelTitle: string;
    cancelBody: string;
    cancelHint: string;
    settingsTitle: string;
    settingsBody: string;
    settingsHint: string;
    doneTitle: string;
    doneBody: string;
    skip: string;
    back: string;
    next: string;
    start: string;
  };
  settings: {
    language: string;
    languagePt: string;
    languageEn: string;
    aboutSection: string;
  };
}

/** Portuguese (PT-PT) — current default for existing installs. */
export const pt: Dictionary = {
  app: {
    settingsAria: 'Definições',
    muteOn: 'Voz mutada — clica para activar',
    muteOff: 'Mutar voz da Hermes',
    muteTitleOn: 'Voz mutada',
    muteTitleOff: 'Mutar voz',
    windowTitle: (state) => `Voice Gateway — ${state}`,
    cancelCaptureAria: 'Cancelar gravação',
    notificationReply: 'Hermes respondeu',
    micPickerAria: 'Escolher microfone',
    micPickerTitle: 'Microfone',
    speakerPickerAria: 'Escolher auscultadores',
    speakerPickerTitle: 'Saída de áudio',
    devicePickerDefault: 'Padrão do sistema',
    devicePickerNoLabels:
      'Concede permissão de microfone para ver os nomes dos dispositivos.',
  },
  state: {
    IDLE: 'Pronto',
    LISTENING_WAKE: 'À escuta',
    CAPTURING: 'A ouvir',
    STREAMING: 'A transcrever',
    THINKING: 'A pensar',
    SPEAKING: 'A responder',
    ERROR: 'Erro',
  },
  disabledReason: {
    micDenied: 'Sem permissão para o microfone — vai a Definições do sistema',
    micRestricted: 'Microfone restrito por política do sistema',
    micPending: 'A pedir permissão do microfone…',
    noConnection: 'Sem ligação ao Hermes',
    sttPreparing: 'Reconhecimento de voz a preparar…',
    sttError: 'Reconhecimento de voz com erro — vê Definições',
    sttNotReady: 'Reconhecimento de voz ainda não pronto',
    ttsError: 'Voz com erro — vê Definições',
  },
  transcript: {
    emptyPtt: 'Carrega no botão ou usa o atalho para começar.',
    emptyWake: 'Diz a palavra-chave ou usa o atalho para começar.',
    copy: 'copiar',
    clear: 'limpar',
    nMessages: (n) => `${n} ${n === 1 ? 'mensagem' : 'mensagens'}`,
    copyAria: 'Copiar conversa',
    clearAria: 'Limpar conversa',
    userPrefix: 'tu',
    assistantPrefix: 'hermes',
    exportUser: 'Tu',
    exportAssistant: 'Hermes',
  },
  errorToast: {
    retry: 'Tentar de novo',
    copyDiag: 'Copiar diagnóstico',
  },
  micPermission: {
    deniedTitle: 'O Voice Gateway precisa de permissão para usar o microfone.',
    deniedBody:
      'Abre as Definições do sistema para autorizar o microfone — o botão de chamada só fica activo depois.',
    pendingTitle: 'Permissão do microfone ainda não confirmada.',
    pendingBody:
      'Carrega em Pedir permissão. Se o macOS já tiver respondido, a permissão aparece quando voltares à janela.',
    request: 'Pedir permissão',
    openSettings: 'Abrir Definições do sistema',
  },
  hotkeyHint: {
    template: (wakeLabel) => `Carrega no botão ${wakeLabel}.`,
    sayWakePhrase: (phrase) => `ou diz «${phrase}»`,
    orShortcut: (hotkey) => `ou usa ${hotkey}`,
  },
  connection: {
    connectedWithLatency: (ms) => (ms != null ? `Ligado (${ms} ms)` : 'Ligado'),
    connecting: 'A ligar…',
    connectingAttempt: (n) => `A ligar… (tentativa ${n})`,
    disconnectedClick: 'Sem ligação — clica para tentar ligar',
    disconnectedAttempt: (n) => `Sem ligação (tentativa ${n}) — clica para tentar`,
    activeTitle: 'Ligação activa',
    retryTitle: 'Clica para tentar ligar novamente',
  },
  tutorial: {
    welcomeTitle: 'Bem-vindo ao Voice Gateway 👋',
    welcomeBody:
      'Em três ecrãs ensino-te o básico. Demora menos de 30 segundos e podes saltar quando quiseres.',
    pressTitle: 'Carrega no botão para falar',
    pressBody:
      'O grande botão violeta no centro da janela é o teu microfone. Mantém premido enquanto falas e larga quando acabares — o Hermes responde em segundos.',
    pressHint: 'Em alternativa, usa o atalho global (configurado no setup).',
    cancelTitle: 'O X cancela a meio',
    cancelBody:
      'Enquanto estás a falar, aparece um botão "×" pequenino ao lado do microfone. Carrega aí (ou prime Escape) para cancelar o turno sem enviar nada.',
    cancelHint: 'Útil quando começas a dizer a coisa errada.',
    settingsTitle: 'Tudo o resto vive em Definições',
    settingsBody:
      'Voz, microfone, palavra-chave, idioma, exportar conversa — tudo num painel acessível pelo ⚙ no canto. Atalho ⌘, abre directamente.',
    settingsHint: 'Cmd+L limpa a conversa · Cmd+S exporta para ficheiro.',
    doneTitle: 'Pronto! Diz olá ao Hermes.',
    doneBody:
      'Se mudares de ideias, podes voltar a abrir este tutorial em Definições → Avançado.',
    skip: 'Saltar tutorial',
    back: '← Anterior',
    next: 'Seguinte →',
    start: 'Começar',
  },
  settings: {
    language: 'Idioma',
    languagePt: 'Português',
    languageEn: 'English',
    aboutSection: 'Sobre',
  },
};
