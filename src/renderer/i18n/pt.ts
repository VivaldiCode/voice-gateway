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
  };
  errorToast: {
    retry: string;
    copyDiag: string;
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
    nMessages: (n: number) => `${n} ${n === 1 ? 'mensagem' : 'mensagens'}`,
  },
  errorToast: {
    retry: 'Tentar de novo',
    copyDiag: 'Copiar diagnóstico',
  },
  settings: {
    language: 'Idioma',
    languagePt: 'Português',
    languageEn: 'English',
    aboutSection: 'Sobre',
  },
};
