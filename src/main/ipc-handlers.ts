import { ipcMain, BrowserWindow, shell, systemPreferences } from 'electron';
import log from 'electron-log/main';
import WebSocket from 'ws';
import { CLIENT_VERSION, IPC } from '@shared/constants';
import type { ElevenLabsConfig, PairingInfo, Settings } from '@shared/types';
import { parseServerMessage } from '@shared/protocol';
import { normalizeBridgeUrl } from '@shared/url-utils';
import type { SettingsStore } from './services/settings-store';
import { ElevenLabsAdapter, PiperAdapter, type TtsAdapter } from './services/tts-service';

export type PrepareTtsCallback = () => Promise<{ ok: boolean; message?: string }>;
export type PrepareSttCallback = () => Promise<{ ok: boolean; message?: string }>;

export interface PairTestResult {
  ok: boolean;
  /** Human-friendly Portuguese message. */
  message: string;
  serverVersion?: string;
  sessionId?: string;
}

const PAIR_TIMEOUT_MS = 8_000;

/**
 * Probe the bridge with a short-lived WebSocket connection. We send `hello`
 * and wait for `welcome`. Any auth failure, timeout, or network issue is
 * mapped to a friendly Portuguese error message — never raw error codes.
 */
export async function testPairing(info: PairingInfo): Promise<PairTestResult> {
  return await new Promise<PairTestResult>((resolve) => {
    let settled = false;
    const done = (r: PairTestResult): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(r);
    };

    const { url: effectiveUrl, pathWasAdded } = normalizeBridgeUrl(info.url);
    if (pathWasAdded) log.info('[VG] pair test: appended /ws to URL', effectiveUrl);

    let ws: WebSocket;
    try {
      ws = new WebSocket(effectiveUrl, {
        headers: { Authorization: `Bearer ${info.token}` },
        handshakeTimeout: PAIR_TIMEOUT_MS,
      });
    } catch (err) {
      log.warn('[VG] pair test: invalid URL', err);
      done({ ok: false, message: 'O endereço não é válido. Tem de começar por ws:// ou wss://.' });
      return;
    }

    const timer = setTimeout(() => {
      done({
        ok: false,
        message: 'Sem resposta a tempo. Verifica se o Hermes está a correr no servidor.',
      });
    }, PAIR_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          client_version: CLIENT_VERSION,
          capabilities: ['stt_local', 'tts_local', 'barge_in', 'streaming_audio'],
        }),
      );
    });

    ws.on('message', (data) => {
      clearTimeout(timer);
      try {
        const parsed = parseServerMessage(JSON.parse(data.toString()));
        if (parsed?.type === 'welcome') {
          done({
            ok: true,
            message: 'Ligação estabelecida.',
            serverVersion: parsed.server_version,
            sessionId: parsed.session_id,
          });
          return;
        }
        if (parsed?.type === 'error') {
          done({ ok: false, message: friendlyError(parsed.code, parsed.message) });
          return;
        }
        done({ ok: false, message: 'O servidor respondeu com uma mensagem inesperada.' });
      } catch {
        done({ ok: false, message: 'O servidor respondeu com algo que não consegui ler.' });
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      if (res.statusCode === 401 || res.statusCode === 403) {
        done({ ok: false, message: 'O token não foi aceite. Verifica se o copiaste sem espaços.' });
        return;
      }
      if (res.statusCode === 404) {
        done({
          ok: false,
          message:
            'O servidor respondeu mas não há um bridge nesse endereço. Confirma que o URL termina em /ws (ex: ws://host:8765/ws).',
        });
        return;
      }
      done({
        ok: false,
        message: `O servidor recusou a ligação (HTTP ${res.statusCode ?? '?'}).`,
      });
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      log.warn('[VG] pair test error', err.message);
      done({ ok: false, message: friendlyConnectError(err.message) });
    });

    ws.on('close', (code) => {
      clearTimeout(timer);
      // If we close before welcome, surface a friendly message. The `error` or
      // `unexpected-response` listeners usually fire first; this is a safety net.
      done({
        ok: false,
        message:
          code === 1006
            ? 'Não consegui ligar. O endereço está certo e o serviço está a correr?'
            : 'O servidor fechou a ligação antes de responder.',
      });
    });
  });
}

function friendlyError(code: string, message: string): string {
  if (code === 'AUTH_FAILED' || code === 'WS_AUTH_FAILED') {
    return 'O token não foi aceite. Verifica se o copiaste sem espaços.';
  }
  return `O servidor respondeu: ${message}`;
}

function friendlyConnectError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('econnrefused')) {
    return 'Não consegui ligar. O endereço está certo e o serviço está a correr?';
  }
  if (lower.includes('enotfound') || lower.includes('eai_again')) {
    return 'Não consegui encontrar o servidor. Verifica o endereço.';
  }
  if (lower.includes('certificate') || lower.includes('self signed')) {
    return 'O certificado do servidor não é de confiança. (Tenta com ws:// se for rede local.)';
  }
  if (lower.includes('timeout')) {
    return 'Sem resposta a tempo. Verifica se o Hermes está a correr no servidor.';
  }
  return 'Não consegui ligar ao Hermes.';
}

export interface VoiceInfo {
  id: string;
  name: string;
  language?: string;
  description?: string;
  preview_url?: string;
}

export interface ListVoicesRequest {
  provider: 'elevenlabs';
  apiKey: string;
}

/**
 * Fetch ElevenLabs voice catalogue. Returns a friendly Portuguese error
 * message on auth failure instead of throwing.
 */
export async function listElevenLabsVoices(
  apiKey: string,
): Promise<{ ok: boolean; voices: VoiceInfo[]; message?: string }> {
  if (!apiKey.trim()) {
    return { ok: false, voices: [], message: 'Falta a chave API da ElevenLabs.' };
  }
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey.trim() },
    });
    if (res.status === 401) {
      return { ok: false, voices: [], message: 'A chave da ElevenLabs foi rejeitada (401).' };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        voices: [],
        message: `A ElevenLabs respondeu HTTP ${res.status}: ${body.slice(0, 120)}`,
      };
    }
    const json = (await res.json()) as { voices?: Array<Record<string, unknown>> };
    const voices: VoiceInfo[] = Array.isArray(json.voices)
      ? json.voices
          .map((v) => {
            const id = typeof v['voice_id'] === 'string' ? v['voice_id'] : '';
            const name = typeof v['name'] === 'string' ? v['name'] : id;
            const labels = (v['labels'] as Record<string, unknown> | undefined) ?? {};
            const language =
              typeof labels['language'] === 'string'
                ? (labels['language'] as string)
                : typeof labels['accent'] === 'string'
                  ? (labels['accent'] as string)
                  : undefined;
            const description =
              typeof v['description'] === 'string' ? (v['description'] as string) : undefined;
            const preview =
              typeof v['preview_url'] === 'string' ? (v['preview_url'] as string) : undefined;
            const out: VoiceInfo = { id, name };
            if (language) out.language = language;
            if (description) out.description = description;
            if (preview) out.preview_url = preview;
            return out;
          })
          .filter((v) => v.id)
      : [];
    return { ok: true, voices };
  } catch (err) {
    log.warn('[VG] list voices error', err);
    return {
      ok: false,
      voices: [],
      message: 'Não consegui contactar a ElevenLabs. Verifica a tua ligação à internet.',
    };
  }
}

export interface TestVoiceRequest {
  provider: 'piper_local' | 'elevenlabs';
  text: string;
  elevenlabs?: ElevenLabsConfig;
  /** Required when provider === 'piper_local' — id of the voice model on disk. */
  piperVoiceId?: string;
}

export type TestTtsChunkPayload = {
  seq: number;
  format: string;
  data: string;
  done?: boolean;
};

/**
 * Run a one-shot TTS synthesis without going through the conversation
 * pipeline. Pushes audio chunks back to the renderer via a dedicated IPC
 * channel so the existing playback layer can be reused.
 */
export async function testVoice(
  req: TestVoiceRequest,
  onChunk: (c: TestTtsChunkPayload) => void,
): Promise<{ ok: boolean; message?: string }> {
  let adapter: TtsAdapter;
  if (req.provider === 'elevenlabs') {
    if (!req.elevenlabs?.apiKey || !req.elevenlabs?.voiceId) {
      return { ok: false, message: 'Falta a chave API ou a voz.' };
    }
    adapter = new ElevenLabsAdapter({ config: req.elevenlabs });
  } else {
    const modelId = req.piperVoiceId ?? 'en_US-lessac-medium';
    adapter = new PiperAdapter({ config: { modelId }, autoInstall: true });
    if (!(await adapter.isReady())) {
      return {
        ok: false,
        message:
          'A voz Piper escolhida ainda não está pronta. Volta ao topo de Definições > Voz e carrega "Descarregar voz agora".',
      };
    }
  }
  return await new Promise<{ ok: boolean; message?: string }>((resolve) => {
    let settled = false;
    const settle = (r: { ok: boolean; message?: string }): void => {
      if (settled) return;
      settled = true;
      adapter.off('chunk', onChunkInternal);
      adapter.off('end', onEnd);
      adapter.off('error', onError);
      resolve(r);
    };
    const onChunkInternal = (c: { data: Buffer; format: string; seq: number }): void => {
      onChunk({ seq: c.seq, format: c.format, data: c.data.toString('base64') });
    };
    const onEnd = (): void => {
      onChunk({ seq: -1, format: '', data: '', done: true });
      settle({ ok: true });
    };
    const onError = (err: Error): void => settle({ ok: false, message: err.message });
    adapter.on('chunk', onChunkInternal);
    adapter.on('end', onEnd);
    adapter.on('error', onError);
    adapter.speak(req.text).catch((err: Error) => settle({ ok: false, message: err.message }));
  });
}

export function registerIpcHandlers(
  settings: SettingsStore,
  getWindow: () => BrowserWindow | null,
  prepareTts: PrepareTtsCallback = async () => ({ ok: true }),
  prepareStt: PrepareSttCallback = async () => ({ ok: true }),
): () => void {
  const handlers: Array<[string, Parameters<typeof ipcMain.handle>[1]]> = [
    [IPC.PING, async () => 'pong' as const],
    [IPC.SETTINGS_GET, async () => settings.get()],
    [IPC.SETTINGS_SET, async (_e, patch: Partial<Settings>) => settings.set(patch)],
    [IPC.SETTINGS_RESET, async () => settings.reset()],
    [IPC.PAIR_TEST, async (_e, info: PairingInfo) => testPairing(info)],
    [
      IPC.PAIR_SAVE,
      async (_e, info: PairingInfo) => {
        const result = await testPairing(info);
        if (result.ok) settings.set({ pairing: info });
        return result;
      },
    ],
    [
      IPC.TTS_LIST_VOICES,
      async (_e, req: ListVoicesRequest) => listElevenLabsVoices(req.apiKey),
    ],
    [
      IPC.TTS_TEST,
      async (_e, req: TestVoiceRequest) =>
        testVoice(req, (chunk) => {
          // Test-voice chunks must reach the window that initiated the
          // request — which is the Settings window. Use a broadcast to be
          // safe (multiple windows can't reasonably overlap on this channel).
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed())
              win.webContents.send(IPC.AUDIO_TEST_TTS_CHUNK, chunk);
          }
        }),
    ],
    [IPC.TTS_PREPARE, async () => prepareTts()],
    [IPC.STT_PREPARE, async () => prepareStt()],
    [
      IPC.AUDIO_MIC_STATUS,
      async () => {
        if (process.platform !== 'darwin') return 'granted';
        try {
          return systemPreferences.getMediaAccessStatus('microphone');
        } catch (err) {
          log.warn('[VG] getMediaAccessStatus failed', err);
          return 'unknown';
        }
      },
    ],
    [
      IPC.AUDIO_MIC_REQUEST,
      async () => {
        if (process.platform !== 'darwin') return true;
        try {
          return await systemPreferences.askForMediaAccess('microphone');
        } catch (err) {
          log.warn('[VG] askForMediaAccess failed', err);
          return false;
        }
      },
    ],
    [
      IPC.AUDIO_OPEN_MIC_SETTINGS,
      async () => {
        if (process.platform === 'darwin') {
          await shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
          );
          return true;
        }
        return false;
      },
    ],
  ];

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, handler);
  }

  const unsubscribe = settings.onChange((next) => {
    // Broadcast to all windows: when the user changes a setting in the
    // dedicated Settings window we want the main window to update its UI
    // (e.g. connection bar, activation mode) too.
    void getWindow; // silence unused — kept for callers that still pass it
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.SETTINGS_CHANGED, next);
    }
  });

  return () => {
    unsubscribe();
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
  };
}
