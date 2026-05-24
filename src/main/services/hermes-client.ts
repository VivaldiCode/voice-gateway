import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import log from 'electron-log/main';
import {
  CLIENT_VERSION,
  ERROR_CODES,
  WS_PING_INTERVAL_MS,
  WS_PONG_TIMEOUT_MS,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
} from '@shared/constants';
import {
  type ClientCapability,
  type ClientMessage,
  type InterruptReason,
  type MsgError,
  type MsgResponseAudioChunk,
  type MsgResponseEnd,
  type MsgResponseText,
  type MsgServerTranscript,
  type MsgThinking,
  type MsgWelcome,
  type ServerMessage,
  parseServerMessage,
} from '@shared/protocol';
import { normalizeBridgeUrl } from '@shared/url-utils';
import type { ConnectionStatus, PairingInfo } from '@shared/types';

type ClientCapsList = readonly ClientCapability[];

export interface HermesClientOptions {
  /** Capabilities advertised by this client. Defaults reflect a desktop install. */
  capabilities?: ClientCapsList;
  /** Override the WS implementation (used by tests). */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
  /** Override the timer wiring (used by tests). Defaults to global timers. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface HermesClientEvents {
  status: (
    status: ConnectionStatus,
    info: { latencyMs: number | null; lastError: string | null; reconnectAttempt: number },
  ) => void;
  welcome: (msg: MsgWelcome) => void;
  transcript: (msg: MsgServerTranscript) => void;
  thinking: (msg: MsgThinking) => void;
  response_text: (msg: MsgResponseText) => void;
  response_audio_chunk: (msg: MsgResponseAudioChunk, payload: Buffer) => void;
  response_end: (msg: MsgResponseEnd) => void;
  error: (msg: MsgError) => void;
  /** Generic socket-level error (parse failure, transport error, etc). */
  client_error: (code: string, message: string) => void;
}

const DEFAULT_CAPS: ClientCapsList = [
  'stt_local',
  'tts_local',
  'barge_in',
  'streaming_audio',
];

/**
 * Long-lived WebSocket client for the Hermes Voice Bridge.
 *
 * - Single instance per pairing. Call `connect(info)` once after pair info is
 *   known; the client reconnects on its own with exponential backoff.
 * - `disconnect()` is sticky: it stops reconnection until the next
 *   `connect()` call.
 * - Heartbeat: a ping is sent every `WS_PING_INTERVAL_MS`. If no pong
 *   arrives within `WS_PONG_TIMEOUT_MS`, the socket is forcibly closed and
 *   reconnect is scheduled.
 *
 * Binary audio chunks are sent as two frames: a JSON header (`audio_chunk`)
 * followed by the raw PCM buffer. Incoming `response_audio_chunk` is parsed
 * the same way: the next binary frame is paired with the most recent header.
 */
export class HermesClient extends EventEmitter {
  private readonly capabilities: ClientCapsList;
  private readonly wsFactory: NonNullable<HermesClientOptions['wsFactory']>;
  private readonly setT: typeof setTimeout;
  private readonly clearT: typeof clearTimeout;
  private readonly setI: typeof setInterval;
  private readonly clearI: typeof clearInterval;

  private ws: WebSocket | null = null;
  private pairingInfo: PairingInfo | null = null;
  private status: ConnectionStatus = 'disconnected';
  private lastError: string | null = null;
  private lastLatencyMs: number | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private pendingAudioHeader: MsgResponseAudioChunk | null = null;
  private explicitDisconnect = false;
  private pingSentAt = 0;

  constructor(opts: HermesClientOptions = {}) {
    super();
    this.capabilities = opts.capabilities ?? DEFAULT_CAPS;
    this.wsFactory =
      opts.wsFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
          handshakeTimeout: 8_000,
          perMessageDeflate: false,
        }));
    this.setT = opts.setTimeout ?? setTimeout;
    this.clearT = opts.clearTimeout ?? clearTimeout;
    this.setI = opts.setInterval ?? setInterval;
    this.clearI = opts.clearInterval ?? clearInterval;
  }

  // --- Public surface -----------------------------------------------------

  connect(info: PairingInfo): void {
    const normalized = normalizeBridgeUrl(info.url);
    if (normalized.pathWasAdded) {
      log.info('[VG] hermes connect: appended /ws to URL →', normalized.url);
    }
    this.pairingInfo = { ...info, url: normalized.url };
    this.explicitDisconnect = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  disconnect(): void {
    this.explicitDisconnect = true;
    this.cancelReconnect();
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Cancel any pending exponential-backoff sleep and retry NOW. Used by the
   * main process to react to window-focus events: after a laptop sleep cycle
   * we want the user to see "Ligado" immediately, not wait another 30 s.
   *
   * No-op when explicitly disconnected, already connected, or when there's
   * no pairing to retry against.
   */
  reconnectNow(): void {
    if (this.explicitDisconnect) return;
    if (!this.pairingInfo) return;
    if (this.isConnected()) return;
    this.cancelReconnect();
    this.openSocket();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getLatencyMs(): number | null {
    return this.lastLatencyMs;
  }

  sendStartTurn(turnId: string, lang?: string): void {
    this.sendJson({ type: 'start_turn', turn_id: turnId, ...(lang ? { lang } : {}) });
  }

  sendAudioChunk(turnId: string, seq: number, pcm: Buffer | Uint8Array): void {
    if (!this.assertOpen()) return;
    this.sendJson({ type: 'audio_chunk', turn_id: turnId, seq });
    this.ws?.send(pcm, { binary: true });
  }

  sendEndTurn(turnId: string): void {
    this.sendJson({ type: 'end_turn', turn_id: turnId });
  }

  sendInterrupt(reason: InterruptReason): void {
    this.sendJson({ type: 'interrupt', reason });
  }

  sendClientTranscript(turnId: string, text: string, final: boolean): void {
    this.sendJson({ type: 'transcript', turn_id: turnId, text, final });
  }

  // --- Internal -----------------------------------------------------------

  private openSocket(): void {
    if (!this.pairingInfo) return;
    this.cancelReconnect();
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = this.wsFactory(this.pairingInfo.url, {
        Authorization: `Bearer ${this.pairingInfo.token}`,
      });
    } catch (err) {
      this.handleTransportError(err instanceof Error ? err.message : 'unknown');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.attachListeners(ws);
  }

  private attachListeners(ws: WebSocket): void {
    ws.on('open', () => {
      this.sendJson({
        type: 'hello',
        client_version: CLIENT_VERSION,
        capabilities: [...this.capabilities],
      });
    });

    ws.on('message', (data, isBinary) => this.handleMessage(data, isBinary));

    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode === 401 || res.statusCode === 403
        ? ERROR_CODES.WS_AUTH_FAILED
        : ERROR_CODES.WS_DISCONNECTED;
      this.handleTransportError(`HTTP ${res.statusCode ?? '?'}`, code);
      try {
        ws.close();
      } catch {
        // ignore
      }
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.handleTransportError(err.message);
    });

    ws.on('close', () => {
      this.stopHeartbeat();
      this.pendingAudioHeader = null;
      if (this.ws === ws) this.ws = null;
      if (this.explicitDisconnect) {
        this.setStatus('disconnected');
        return;
      }
      this.setStatus('disconnected');
      this.scheduleReconnect();
    });
  }

  private handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      const header = this.pendingAudioHeader;
      this.pendingAudioHeader = null;
      if (!header) {
        this.emitClientError(ERROR_CODES.WS_INVALID_MESSAGE, 'binary frame without preceding header');
        return;
      }
      this.emit('response_audio_chunk', header, toBuffer(data));
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(toBuffer(data).toString('utf-8'));
    } catch {
      this.emitClientError(ERROR_CODES.WS_INVALID_MESSAGE, 'invalid JSON frame');
      return;
    }
    const msg = parseServerMessage(raw);
    if (!msg) {
      this.emitClientError(ERROR_CODES.WS_INVALID_MESSAGE, 'unrecognised server message');
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.reconnectAttempt = 0;
        this.setStatus('connected');
        this.startHeartbeat();
        this.emit('welcome', msg);
        return;
      case 'pong':
        this.lastLatencyMs = Math.max(0, Date.now() - this.pingSentAt);
        if (this.pongDeadline) {
          this.clearT(this.pongDeadline);
          this.pongDeadline = null;
        }
        this.emitStatusFresh();
        return;
      case 'response_audio_chunk':
        this.pendingAudioHeader = msg;
        return;
      case 'transcript':
        this.emit('transcript', msg);
        return;
      case 'thinking':
        this.emit('thinking', msg);
        return;
      case 'response_text':
        this.emit('response_text', msg);
        return;
      case 'response_end':
        this.emit('response_end', msg);
        return;
      case 'error':
        this.lastError = msg.message;
        this.emit('error', msg);
        return;
    }
  }

  private sendJson(msg: ClientMessage): void {
    if (!this.assertOpen()) return;
    this.ws?.send(JSON.stringify(msg));
  }

  private assertOpen(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      log.warn('[VG] hermes send while not open', { state: this.ws?.readyState ?? 'null' });
      return false;
    }
    return true;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = this.setI(() => {
      if (!this.isConnected()) return;
      this.pingSentAt = Date.now();
      this.sendJson({ type: 'ping' });
      this.pongDeadline = this.setT(() => {
        log.warn('[VG] hermes pong timeout, forcing reconnect');
        try {
          this.ws?.terminate();
        } catch {
          // ignore
        }
      }, WS_PONG_TIMEOUT_MS);
    }, WS_PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      this.clearI(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongDeadline) {
      this.clearT(this.pongDeadline);
      this.pongDeadline = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.explicitDisconnect) return;
    this.cancelReconnect();
    this.reconnectAttempt += 1;
    const delay = Math.min(
      WS_RECONNECT_MAX_MS,
      WS_RECONNECT_BASE_MS * 2 ** Math.min(8, this.reconnectAttempt - 1),
    );
    log.info('[VG] hermes reconnect in', delay, 'ms (attempt', this.reconnectAttempt, ')');
    this.reconnectTimer = this.setT(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      this.clearT(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.emitStatusFresh();
  }

  private emitStatusFresh(): void {
    this.emit('status', this.status, {
      latencyMs: this.lastLatencyMs,
      lastError: this.lastError,
      // 0 while connected (we reset it on welcome). The renderer uses this to
      // surface "A ligar… (tentativa N)" during a reconnect storm.
      reconnectAttempt: this.reconnectAttempt,
    });
  }

  private handleTransportError(message: string, code: string = ERROR_CODES.WS_DISCONNECTED): void {
    this.lastError = message;
    this.setStatus('error');
    this.emitClientError(code, message);
  }

  private emitClientError(code: string, message: string): void {
    this.emit('client_error', code, message);
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
