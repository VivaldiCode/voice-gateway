import { useEffect, useMemo, useState } from 'react';
import { AudioCapture } from '../lib/audio-capture';
import { AudioPlayback, type PlaybackFormat } from '../lib/audio-playback';
import type { TranscriptLine } from '../components/TranscriptView';
import type { SttStatus } from '../global';

type State =
  | 'IDLE'
  | 'LISTENING_WAKE'
  | 'CAPTURING'
  | 'STREAMING'
  | 'THINKING'
  | 'SPEAKING'
  | 'ERROR';

interface ConnectionDisplay {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  latencyMs: number | null;
  lastError: string | null;
}

export interface ConversationApi {
  state: State;
  transcript: TranscriptLine[];
  connection: ConnectionDisplay;
  error: string | null;
  sttStatus: SttStatus;
  pressTalk: () => void;
  releaseTalk: () => void;
  cancel: () => void;
  bargeIn: () => void;
}

const INITIAL_CONNECTION: ConnectionDisplay = {
  status: 'disconnected',
  latencyMs: null,
  lastError: null,
};

export function useConversation(): ConversationApi {
  const [state, setState] = useState<State>('IDLE');
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [connection, setConnection] = useState<ConnectionDisplay>(INITIAL_CONNECTION);
  const [error, setError] = useState<string | null>(null);
  const [sttStatus, setSttStatus] = useState<SttStatus>({ state: 'idle' });

  const capture = useMemo(() => new AudioCapture(), []);
  const playback = useMemo(() => new AudioPlayback(), []);

  useEffect(() => {
    const offState = window.vg.conversation.onState((s) => {
      setState(s.state as State);
      if (s.state === 'IDLE' || s.state === 'LISTENING_WAKE') setError(null);
    });
    const offTranscript = window.vg.conversation.onTranscript((m) => {
      if (!m.text) return;
      setTranscript((prev) => [...prev, { id: `${m.turnId}-u`, role: m.role, text: m.text }]);
    });
    const offResponse = window.vg.conversation.onResponseText((m) => {
      setTranscript((prev) => {
        const idx = prev.findIndex((p) => p.id === `${m.turnId}-a`);
        if (idx === -1)
          return [...prev, { id: `${m.turnId}-a`, role: 'assistant', text: m.text }];
        const next = prev.slice();
        const existing = next[idx];
        if (existing) next[idx] = { ...existing, text: m.text };
        return next;
      });
    });
    const offTts = window.vg.conversation.onTtsChunk((m) => {
      const bytes = base64ToBytes(m.data);
      playback.pushChunk(bytes, m.format as PlaybackFormat);
    });
    const offError = window.vg.conversation.onError((m) => setError(m.message));
    const offConn = window.vg.conversation.onConnection((m) => {
      setConnection({
        status: m.status as ConnectionDisplay['status'],
        latencyMs: m.latencyMs,
        lastError: m.lastError,
      });
    });
    const offHotkey = window.vg.conversation.onHotkey(() => {
      // The main process drives the FSM transitions; we just react to state.
    });
    const offStt = window.vg.stt.onStatus(setSttStatus);

    return () => {
      offState();
      offTranscript();
      offResponse();
      offTts();
      offError();
      offConn();
      offHotkey();
      offStt();
    };
  }, [playback]);

  useEffect(() => {
    if (state === 'CAPTURING') {
      void capture.start().then(() => {
        const off = capture.onFrame((frame) => {
          const copy = new ArrayBuffer(frame.byteLength);
          new Uint8Array(copy).set(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
          window.vg.conversation.sendAudioFrame(copy);
        });
        capture.setMuted(false);
        // store cleanup
        (capture as unknown as { _off?: () => void })._off = off;
      });
    } else {
      const r = capture as unknown as { _off?: () => void };
      r._off?.();
      void capture.stop();
    }
    if (state === 'SPEAKING') {
      playback.beginUtterance('pcm16_22050');
    } else if (state === 'IDLE' || state === 'LISTENING_WAKE') {
      playback.endUtterance();
    }
  }, [state, capture, playback]);

  return {
    state,
    transcript,
    connection,
    error,
    sttStatus,
    pressTalk: () => window.vg.conversation.pttPress(),
    releaseTalk: () => window.vg.conversation.pttRelease(),
    cancel: () => window.vg.conversation.cancel(),
    bargeIn: () => window.vg.conversation.bargeIn(),
  };
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
