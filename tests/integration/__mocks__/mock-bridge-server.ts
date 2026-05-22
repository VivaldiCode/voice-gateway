import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { parseClientMessage, type ServerMessage } from '@shared/protocol';

export interface MockBridgeOptions {
  expectedToken?: string;
  serverVersion?: string;
  sessionId?: string;
  /** If set, intercept incoming client messages and return a scripted reply. */
  onClientMessage?: (msg: unknown, send: (m: ServerMessage) => void) => void;
}

export interface MockBridge {
  readonly url: string;
  readonly port: number;
  readonly connections: Set<WebSocket>;
  /** Send a message to every connected client. */
  broadcast(m: ServerMessage): void;
  close(): Promise<void>;
}

const DEFAULT_TOKEN = 'test-token-1234567890abcdef';

/**
 * In-process mock of the Hermes Voice Bridge for integration tests.
 * Listens on an ephemeral port. Validates the Authorization header and the
 * client `hello`, replies with `welcome`, then echoes/scripts as configured.
 */
export async function startMockBridge(opts: MockBridgeOptions = {}): Promise<MockBridge> {
  const expectedToken = opts.expectedToken ?? DEFAULT_TOKEN;
  const serverVersion = opts.serverVersion ?? 'mock-1.0.0';
  const sessionIdBase = opts.sessionId ?? 'mock-session';

  const wss = new WebSocketServer({
    port: 0,
    perMessageDeflate: false,
    verifyClient: (info, done) => {
      const auth = info.req.headers['authorization'];
      if (auth !== `Bearer ${expectedToken}`) {
        done(false, 401, 'unauthorized');
        return;
      }
      done(true);
    },
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const addr = wss.address() as AddressInfo;
  const port = addr.port;
  const url = `ws://127.0.0.1:${port}`;

  const connections = new Set<WebSocket>();
  let sessionCounter = 0;

  wss.on('connection', (ws) => {
    connections.add(ws);
    ws.on('close', () => connections.delete(ws));

    const send = (m: ServerMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // ignore binary in mock; tests can hook via onClientMessage
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = parseClientMessage(value);
      if (parsed?.type === 'hello') {
        sessionCounter += 1;
        send({
          type: 'welcome',
          session_id: `${sessionIdBase}-${sessionCounter}`,
          server_version: serverVersion,
          capabilities: ['stt_server', 'tts_server', 'streaming_audio'],
        });
        return;
      }
      if (parsed?.type === 'ping') {
        send({ type: 'pong' });
        return;
      }
      opts.onClientMessage?.(value, send);
    });
  });

  return {
    url,
    port,
    connections,
    broadcast(m) {
      for (const c of connections) {
        if (c.readyState === c.OPEN) c.send(JSON.stringify(m));
      }
    },
    async close() {
      for (const c of connections) {
        try {
          c.terminate();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export const MOCK_DEFAULT_TOKEN = DEFAULT_TOKEN;
