import { describe, expect, it } from 'vitest';
import {
  type ClientCapability,
  type ServerCapability,
  negotiate,
  parseClientMessage,
  parseServerMessage,
} from '@shared/protocol';

describe('protocol — parseClientMessage', () => {
  it('parses hello', () => {
    const m = parseClientMessage({
      type: 'hello',
      client_version: '0.1.0',
      capabilities: ['stt_local', 'tts_local'],
    });
    expect(m).toEqual({
      type: 'hello',
      client_version: '0.1.0',
      capabilities: ['stt_local', 'tts_local'],
    });
  });

  it('rejects hello missing capabilities', () => {
    expect(parseClientMessage({ type: 'hello', client_version: '1' })).toBeNull();
  });

  it('parses start_turn with optional lang', () => {
    expect(parseClientMessage({ type: 'start_turn', turn_id: 't1', lang: 'pt' })).toEqual({
      type: 'start_turn',
      turn_id: 't1',
      lang: 'pt',
    });
    expect(parseClientMessage({ type: 'start_turn', turn_id: 't1' })).toEqual({
      type: 'start_turn',
      turn_id: 't1',
    });
  });

  it('parses audio_chunk with seq', () => {
    expect(parseClientMessage({ type: 'audio_chunk', turn_id: 't', seq: 3 })).toEqual({
      type: 'audio_chunk',
      turn_id: 't',
      seq: 3,
    });
  });

  it('parses interrupt with valid reason', () => {
    expect(parseClientMessage({ type: 'interrupt', reason: 'user_barge_in' })).toEqual({
      type: 'interrupt',
      reason: 'user_barge_in',
    });
    expect(parseClientMessage({ type: 'interrupt', reason: 'invalid' })).toBeNull();
  });

  it('parses transcript', () => {
    expect(
      parseClientMessage({ type: 'transcript', turn_id: 't', text: 'olá', final: true }),
    ).toEqual({ type: 'transcript', turn_id: 't', text: 'olá', final: true });
  });

  it('parses ping', () => {
    expect(parseClientMessage({ type: 'ping' })).toEqual({ type: 'ping' });
  });

  it('rejects unknown type', () => {
    expect(parseClientMessage({ type: 'nonsense' })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage('hello')).toBeNull();
    expect(parseClientMessage([1, 2, 3])).toBeNull();
  });
});

describe('protocol — parseServerMessage', () => {
  it('parses welcome', () => {
    expect(
      parseServerMessage({
        type: 'welcome',
        session_id: 's1',
        server_version: '1.0.0',
        capabilities: ['tts_server'],
      }),
    ).toEqual({
      type: 'welcome',
      session_id: 's1',
      server_version: '1.0.0',
      capabilities: ['tts_server'],
    });
  });

  it('parses thinking / response_end / pong', () => {
    expect(parseServerMessage({ type: 'thinking', turn_id: 't' })).toEqual({
      type: 'thinking',
      turn_id: 't',
    });
    expect(parseServerMessage({ type: 'response_end', turn_id: 't' })).toEqual({
      type: 'response_end',
      turn_id: 't',
    });
    expect(parseServerMessage({ type: 'pong' })).toEqual({ type: 'pong' });
  });

  it('parses response_audio_chunk with valid format', () => {
    expect(
      parseServerMessage({
        type: 'response_audio_chunk',
        turn_id: 't',
        seq: 0,
        format: 'pcm16_24khz',
      }),
    ).toEqual({
      type: 'response_audio_chunk',
      turn_id: 't',
      seq: 0,
      format: 'pcm16_24khz',
    });
    expect(
      parseServerMessage({ type: 'response_audio_chunk', turn_id: 't', seq: 0, format: 'wav' }),
    ).toBeNull();
  });

  it('parses error with optional turn_id', () => {
    expect(parseServerMessage({ type: 'error', code: 'X', message: 'y' })).toEqual({
      type: 'error',
      code: 'X',
      message: 'y',
    });
    expect(parseServerMessage({ type: 'error', code: 'X', message: 'y', turn_id: 't' })).toEqual({
      type: 'error',
      code: 'X',
      message: 'y',
      turn_id: 't',
    });
  });

  it('rejects type with wrong field type', () => {
    expect(parseServerMessage({ type: 'transcript', turn_id: 1, text: 'x', final: true })).toBeNull();
  });
});

describe('protocol — negotiate', () => {
  it('STT stays on client when client advertises stt_local', () => {
    const caps = negotiate(
      ['stt_local', 'tts_local'] as ClientCapability[],
      ['stt_server', 'tts_server'] as ServerCapability[],
    );
    expect(caps.sttOnServer).toBe(false);
    expect(caps.ttsOnServer).toBe(false);
  });

  it('STT moves to server when client lacks local STT', () => {
    const caps = negotiate(
      ['tts_local'] as ClientCapability[],
      ['stt_server'] as ServerCapability[],
    );
    expect(caps.sttOnServer).toBe(true);
    expect(caps.ttsOnServer).toBe(false);
  });

  it('barge-in only when client supports it', () => {
    expect(negotiate(['barge_in'], []).bargeIn).toBe(true);
    expect(negotiate([], []).bargeIn).toBe(false);
  });

  it('streaming audio requires both sides', () => {
    expect(
      negotiate(['streaming_audio'] as ClientCapability[], [] as ServerCapability[]).streamingAudio,
    ).toBe(false);
    expect(
      negotiate(['streaming_audio'] as ClientCapability[], ['streaming_audio'] as ServerCapability[])
        .streamingAudio,
    ).toBe(true);
  });
});
