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

  // ───── server message parser — extra rejection paths
  it('rejects welcome missing capabilities', () => {
    expect(
      parseServerMessage({ type: 'welcome', session_id: 's', server_version: 'v' }),
    ).toBeNull();
  });

  it('rejects welcome with non-string-array capabilities', () => {
    expect(
      parseServerMessage({
        type: 'welcome',
        session_id: 's',
        server_version: 'v',
        capabilities: ['ok', 7],
      }),
    ).toBeNull();
  });

  it('rejects server transcript missing the final boolean', () => {
    expect(
      parseServerMessage({ type: 'transcript', turn_id: 't', text: 'olá' }),
    ).toBeNull();
  });

  it('rejects thinking missing turn_id', () => {
    expect(parseServerMessage({ type: 'thinking' })).toBeNull();
  });

  it('rejects response_text missing the final flag', () => {
    expect(
      parseServerMessage({ type: 'response_text', turn_id: 't', text: 'olá' }),
    ).toBeNull();
  });

  it('rejects response_audio_chunk missing seq', () => {
    expect(
      parseServerMessage({
        type: 'response_audio_chunk',
        turn_id: 't',
        format: 'pcm16_24khz',
      }),
    ).toBeNull();
  });

  it('rejects response_audio_chunk with a non-number seq', () => {
    expect(
      parseServerMessage({
        type: 'response_audio_chunk',
        turn_id: 't',
        seq: 'zero',
        format: 'pcm16_24khz',
      }),
    ).toBeNull();
  });

  it('rejects response_end missing turn_id', () => {
    expect(parseServerMessage({ type: 'response_end' })).toBeNull();
  });

  it('rejects error frame missing the code field', () => {
    expect(parseServerMessage({ type: 'error', message: 'oops' })).toBeNull();
  });

  it('rejects error frame missing the message field', () => {
    expect(parseServerMessage({ type: 'error', code: 'X' })).toBeNull();
  });

  it('drops a non-string turn_id on error optional field', () => {
    const r = parseServerMessage({ type: 'error', code: 'X', message: 'y', turn_id: 42 });
    // Optional turn_id with the wrong shape is silently dropped — the
    // contract is "if present, must be string" not "fail the whole frame".
    expect(r).toEqual({ type: 'error', code: 'X', message: 'y' });
  });

  it('parses pong with an irrelevant payload (forward-compatible)', () => {
    expect(parseServerMessage({ type: 'pong', extra: 'whatever' })).toEqual({ type: 'pong' });
  });

  it('rejects null + undefined + array roots', () => {
    expect(parseServerMessage(null)).toBeNull();
    expect(parseServerMessage(undefined)).toBeNull();
    expect(parseServerMessage([])).toBeNull();
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
