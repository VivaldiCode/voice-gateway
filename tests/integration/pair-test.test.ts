import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testPairing } from '@main/ipc-handlers';
import { MOCK_DEFAULT_TOKEN, startMockBridge, type MockBridge } from './__mocks__/mock-bridge-server';

describe('testPairing — integration with mock bridge', () => {
  let bridge: MockBridge;

  beforeEach(async () => {
    bridge = await startMockBridge();
  });

  afterEach(async () => {
    await bridge.close();
  });

  it('returns ok with serverVersion on valid token', async () => {
    const r = await testPairing({ url: bridge.url, token: MOCK_DEFAULT_TOKEN });
    expect(r.ok).toBe(true);
    expect(r.serverVersion).toBe('mock-1.0.0');
    expect(r.sessionId).toContain('mock-session-');
  });

  it('returns friendly error on bad token', async () => {
    const r = await testPairing({ url: bridge.url, token: 'wrong-token-aaaaaaaaaaaa' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/não consegui ligar|token/i);
  });

  it('returns friendly error on unreachable host', async () => {
    const r = await testPairing({
      url: 'ws://127.0.0.1:1', // closed port
      token: MOCK_DEFAULT_TOKEN,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/não consegui|servidor|verifica/i);
  });
});
