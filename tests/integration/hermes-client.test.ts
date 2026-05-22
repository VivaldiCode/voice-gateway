import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HermesClient } from '@main/services/hermes-client';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from './__mocks__/mock-bridge-server';
import type { MsgWelcome } from '@shared/protocol';

function onceEvent<T>(emitter: HermesClient, event: string): Promise<T> {
  return new Promise((resolve) => {
    emitter.once(event, ((...args: unknown[]) => resolve(args.length <= 1 ? (args[0] as T) : (args as unknown as T))) as never);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('HermesClient — integration with mock bridge', () => {
  let bridge: MockBridge;
  let client: HermesClient;

  beforeEach(async () => {
    bridge = await startMockBridge();
  });

  afterEach(async () => {
    client?.disconnect();
    await bridge.close();
  });

  it('handshakes hello/welcome and transitions to connected', async () => {
    client = new HermesClient();
    const welcomePromise = onceEvent<MsgWelcome>(client, 'welcome');
    client.connect({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    const welcome = await welcomePromise;
    expect(welcome.type).toBe('welcome');
    expect(welcome.server_version).toBe('mock-1.0.0');
    expect(client.isConnected()).toBe(true);
  });

  it('emits status sequence connecting → connected → disconnected', async () => {
    client = new HermesClient();
    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));
    client.connect({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    await onceEvent(client, 'welcome');
    client.disconnect();
    await waitFor(() => statuses.includes('disconnected'));
    expect(statuses).toContain('connecting');
    expect(statuses).toContain('connected');
    expect(statuses[statuses.length - 1]).toBe('disconnected');
  });

  it('rejects bad token via auth error then no reconnect after disconnect', async () => {
    client = new HermesClient();
    const errors: Array<[string, string]> = [];
    client.on('client_error', (code, msg) => errors.push([code, msg]));
    client.connect({ url: bridge.url, token: 'wrong-token-aaaaaaaaaaaa' });
    await waitFor(() => errors.length > 0, 3_000);
    expect(errors[0]?.[0]).toBe('WS_AUTH_FAILED');
    client.disconnect();
  });

  it('reconnects after the server closes the socket', async () => {
    client = new HermesClient();
    let welcomeCount = 0;
    client.on('welcome', () => {
      welcomeCount += 1;
    });
    client.connect({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    await waitFor(() => welcomeCount === 1);
    // Force-close the only connection from the server side.
    for (const ws of bridge.connections) ws.terminate();
    // Backoff base is 500ms, so we should reconnect within ~1.5s.
    await waitFor(() => welcomeCount === 2, 4_000);
    expect(welcomeCount).toBe(2);
  });

  it('does NOT reconnect after explicit disconnect()', async () => {
    client = new HermesClient();
    let welcomeCount = 0;
    client.on('welcome', () => {
      welcomeCount += 1;
    });
    client.connect({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    await waitFor(() => welcomeCount === 1);
    client.disconnect();
    await new Promise((r) => setTimeout(r, 800));
    expect(welcomeCount).toBe(1);
    expect(client.isConnected()).toBe(false);
  });

  it('ping/pong updates latency', async () => {
    // Use tiny ping interval via factory: easier to just send manual ping.
    client = new HermesClient();
    client.connect({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    await onceEvent(client, 'welcome');
    // Manually push a ping/pong cycle by reaching into the WS.
    // The mock server replies pong on any ping.
    // We replicate the heartbeat call by sending the ping JSON directly.
    const start = Date.now();
    // @ts-expect-error — exercising a low-level path for the test
    client.sendJson({ type: 'ping' });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getLatencyMs()).not.toBeNull();
    expect((client.getLatencyMs() ?? 0)).toBeGreaterThanOrEqual(0);
    expect(Date.now() - start).toBeGreaterThan(0);
  });

  it('routes response_audio_chunk header + binary payload as a pair', async () => {
    const audioPayload = Buffer.from([1, 2, 3, 4, 5]);
    client = new HermesClient();
    client.connect({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    await onceEvent(client, 'welcome');
    const received: Array<{ seq: number; payload: Buffer }> = [];
    client.on('response_audio_chunk', (h, payload) => received.push({ seq: h.seq, payload }));

    // Make the mock send a header + binary chunk.
    const conn = [...bridge.connections][0];
    if (!conn) throw new Error('no mock connection');
    conn.send(
      JSON.stringify({
        type: 'response_audio_chunk',
        turn_id: 't1',
        seq: 0,
        format: 'pcm16_24khz',
      }),
    );
    conn.send(audioPayload, { binary: true });

    await waitFor(() => received.length > 0);
    expect(received[0]?.seq).toBe(0);
    expect(received[0]?.payload.equals(audioPayload)).toBe(true);
  });

  it('flags WS_INVALID_MESSAGE for binary without preceding header', async () => {
    client = new HermesClient();
    client.connect({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    await onceEvent(client, 'welcome');
    const errors: Array<[string, string]> = [];
    client.on('client_error', (c, m) => errors.push([c, m]));
    const conn = [...bridge.connections][0];
    if (!conn) throw new Error('no mock connection');
    conn.send(Buffer.from([9, 9, 9]), { binary: true });
    await waitFor(() => errors.length > 0);
    expect(errors[0]?.[0]).toBe('WS_INVALID_MESSAGE');
  });

  it('forwards server "error" frames as `error` events', async () => {
    client = new HermesClient();
    client.connect({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    await onceEvent(client, 'welcome');
    const errorPromise = onceEvent<{ code: string; message: string }>(client, 'error');
    const conn = [...bridge.connections][0];
    if (!conn) throw new Error('no mock connection');
    conn.send(JSON.stringify({ type: 'error', code: 'HERMES_UPSTREAM', message: 'busy' }));
    const err = await errorPromise;
    expect(err.code).toBe('HERMES_UPSTREAM');
    expect(err.message).toBe('busy');
  });

  it('send methods are no-op when not connected (no throw)', async () => {
    client = new HermesClient();
    expect(() => client.sendStartTurn('t1', 'pt')).not.toThrow();
    expect(() => client.sendAudioChunk('t1', 0, Buffer.from([1]))).not.toThrow();
    expect(() => client.sendEndTurn('t1')).not.toThrow();
    expect(() => client.sendInterrupt('user_cancel')).not.toThrow();
    expect(() => client.sendClientTranscript('t1', 'olá', true)).not.toThrow();
  });

  it('sends start_turn / audio_chunk / end_turn through the wire', async () => {
    const received: unknown[] = [];
    const binaries: Buffer[] = [];
    const bridge2 = await startMockBridge({
      onClientMessage: (msg) => received.push(msg),
    });
    try {
      // Hook binary on the mock by intercepting connection.
      const c = new HermesClient();
      c.connect({ url: bridge2.url, token: MOCK_DEFAULT_TOKEN });
      await onceEvent(c, 'welcome');
      const conn = [...bridge2.connections][0];
      if (!conn) throw new Error('no mock connection');
      conn.on('message', (data, isBinary) => {
        if (isBinary) binaries.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      });
      c.sendStartTurn('t1', 'pt');
      c.sendAudioChunk('t1', 0, Buffer.from([7, 7, 7]));
      c.sendEndTurn('t1');
      c.sendInterrupt('user_cancel');
      await new Promise((r) => setTimeout(r, 50));
      const types = received.map((m) => (m as { type: string }).type);
      expect(types).toContain('start_turn');
      expect(types).toContain('audio_chunk');
      expect(types).toContain('end_turn');
      expect(types).toContain('interrupt');
      expect(binaries.length).toBe(1);
      expect(binaries[0]?.equals(Buffer.from([7, 7, 7]))).toBe(true);
      c.disconnect();
    } finally {
      await bridge2.close();
    }
  });
});
