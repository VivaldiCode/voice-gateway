import { ipcMain, type BrowserWindow } from 'electron';
import log from 'electron-log/main';
import WebSocket from 'ws';
import { CLIENT_VERSION, IPC } from '@shared/constants';
import type { PairingInfo, Settings } from '@shared/types';
import { parseServerMessage } from '@shared/protocol';
import { normalizeBridgeUrl } from '@shared/url-utils';
import type { SettingsStore } from './services/settings-store';

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

export function registerIpcHandlers(
  settings: SettingsStore,
  getWindow: () => BrowserWindow | null,
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
  ];

  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, handler);
  }

  const unsubscribe = settings.onChange((next) => {
    const win = getWindow();
    win?.webContents.send(IPC.SETTINGS_CHANGED, next);
  });

  return () => {
    unsubscribe();
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
  };
}
