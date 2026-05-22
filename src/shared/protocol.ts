/**
 * WebSocket protocol between the desktop app and the Hermes Voice Bridge.
 *
 * Text frames are JSON. Audio chunks are binary frames preceded by a text
 * header (`audio_chunk` or `response_audio_chunk`) identifying turn + seq.
 *
 * See docs/PROTOCOL.md for the full specification.
 */

export type ClientCapability =
  | 'stt_local'
  | 'stt_cloud'
  | 'tts_local'
  | 'tts_cloud'
  | 'barge_in'
  | 'streaming_audio';

export type ServerCapability =
  | 'stt_server'
  | 'tts_server'
  | 'streaming_text'
  | 'streaming_audio';

export type AudioFormat = 'pcm16_24khz' | 'mp3';

export type InterruptReason = 'user_barge_in' | 'user_cancel';

export interface MsgHello {
  type: 'hello';
  client_version: string;
  capabilities: ClientCapability[];
}

export interface MsgStartTurn {
  type: 'start_turn';
  turn_id: string;
  lang?: string;
}

export interface MsgAudioChunk {
  type: 'audio_chunk';
  turn_id: string;
  seq: number;
}

export interface MsgEndTurn {
  type: 'end_turn';
  turn_id: string;
}

export interface MsgInterrupt {
  type: 'interrupt';
  reason: InterruptReason;
}

export interface MsgClientTranscript {
  type: 'transcript';
  turn_id: string;
  text: string;
  final: boolean;
}

export interface MsgPing {
  type: 'ping';
}

export type ClientMessage =
  | MsgHello
  | MsgStartTurn
  | MsgAudioChunk
  | MsgEndTurn
  | MsgInterrupt
  | MsgClientTranscript
  | MsgPing;

export interface MsgWelcome {
  type: 'welcome';
  session_id: string;
  server_version: string;
  capabilities: ServerCapability[];
}

export interface MsgServerTranscript {
  type: 'transcript';
  turn_id: string;
  text: string;
  final: boolean;
}

export interface MsgThinking {
  type: 'thinking';
  turn_id: string;
}

export interface MsgResponseText {
  type: 'response_text';
  turn_id: string;
  text: string;
  final: boolean;
}

export interface MsgResponseAudioChunk {
  type: 'response_audio_chunk';
  turn_id: string;
  seq: number;
  format: AudioFormat;
}

export interface MsgResponseEnd {
  type: 'response_end';
  turn_id: string;
}

export interface MsgError {
  type: 'error';
  code: string;
  message: string;
  turn_id?: string;
}

export interface MsgPong {
  type: 'pong';
}

export type ServerMessage =
  | MsgWelcome
  | MsgServerTranscript
  | MsgThinking
  | MsgResponseText
  | MsgResponseAudioChunk
  | MsgResponseEnd
  | MsgError
  | MsgPong;

/**
 * Narrow an unknown value to a ClientMessage. Returns null if invalid.
 * Validates the discriminant and required fields only — does not check
 * extraneous fields, since the protocol allows forward-compatible additions.
 */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value)) return null;
  const t = value['type'];
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'hello':
      if (typeof value['client_version'] !== 'string') return null;
      if (!isStringArray(value['capabilities'])) return null;
      return { type: 'hello', client_version: value['client_version'], capabilities: value['capabilities'] as ClientCapability[] };
    case 'start_turn':
      if (typeof value['turn_id'] !== 'string') return null;
      return {
        type: 'start_turn',
        turn_id: value['turn_id'],
        ...(typeof value['lang'] === 'string' ? { lang: value['lang'] } : {}),
      };
    case 'audio_chunk':
      if (typeof value['turn_id'] !== 'string') return null;
      if (typeof value['seq'] !== 'number') return null;
      return { type: 'audio_chunk', turn_id: value['turn_id'], seq: value['seq'] };
    case 'end_turn':
      if (typeof value['turn_id'] !== 'string') return null;
      return { type: 'end_turn', turn_id: value['turn_id'] };
    case 'interrupt':
      if (value['reason'] !== 'user_barge_in' && value['reason'] !== 'user_cancel') return null;
      return { type: 'interrupt', reason: value['reason'] };
    case 'transcript':
      if (typeof value['turn_id'] !== 'string') return null;
      if (typeof value['text'] !== 'string') return null;
      if (typeof value['final'] !== 'boolean') return null;
      return { type: 'transcript', turn_id: value['turn_id'], text: value['text'], final: value['final'] };
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

/**
 * Narrow an unknown value to a ServerMessage. Returns null if invalid.
 */
export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value)) return null;
  const t = value['type'];
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'welcome':
      if (typeof value['session_id'] !== 'string') return null;
      if (typeof value['server_version'] !== 'string') return null;
      if (!isStringArray(value['capabilities'])) return null;
      return {
        type: 'welcome',
        session_id: value['session_id'],
        server_version: value['server_version'],
        capabilities: value['capabilities'] as ServerCapability[],
      };
    case 'transcript':
      if (typeof value['turn_id'] !== 'string') return null;
      if (typeof value['text'] !== 'string') return null;
      if (typeof value['final'] !== 'boolean') return null;
      return { type: 'transcript', turn_id: value['turn_id'], text: value['text'], final: value['final'] };
    case 'thinking':
      if (typeof value['turn_id'] !== 'string') return null;
      return { type: 'thinking', turn_id: value['turn_id'] };
    case 'response_text':
      if (typeof value['turn_id'] !== 'string') return null;
      if (typeof value['text'] !== 'string') return null;
      if (typeof value['final'] !== 'boolean') return null;
      return { type: 'response_text', turn_id: value['turn_id'], text: value['text'], final: value['final'] };
    case 'response_audio_chunk': {
      if (typeof value['turn_id'] !== 'string') return null;
      if (typeof value['seq'] !== 'number') return null;
      if (value['format'] !== 'pcm16_24khz' && value['format'] !== 'mp3') return null;
      return {
        type: 'response_audio_chunk',
        turn_id: value['turn_id'],
        seq: value['seq'],
        format: value['format'],
      };
    }
    case 'response_end':
      if (typeof value['turn_id'] !== 'string') return null;
      return { type: 'response_end', turn_id: value['turn_id'] };
    case 'error':
      if (typeof value['code'] !== 'string') return null;
      if (typeof value['message'] !== 'string') return null;
      return {
        type: 'error',
        code: value['code'],
        message: value['message'],
        ...(typeof value['turn_id'] === 'string' ? { turn_id: value['turn_id'] } : {}),
      };
    case 'pong':
      return { type: 'pong' };
    default:
      return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Compute the negotiated capability set as the intersection of client and
 * server advertised capabilities, mapped to a single shared decision matrix.
 */
export interface NegotiatedCapabilities {
  sttOnServer: boolean;
  ttsOnServer: boolean;
  bargeIn: boolean;
  streamingAudio: boolean;
}

export function negotiate(
  client: ClientCapability[],
  server: ServerCapability[],
): NegotiatedCapabilities {
  const c = new Set(client);
  const s = new Set(server);
  return {
    sttOnServer: s.has('stt_server') && !c.has('stt_local'),
    ttsOnServer: s.has('tts_server') && !c.has('tts_local'),
    bargeIn: c.has('barge_in'),
    streamingAudio: c.has('streaming_audio') && s.has('streaming_audio'),
  };
}
