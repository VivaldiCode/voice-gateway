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
  /** Mic input level in 0..1 (RMS). Only updated while capturing. */
  level: number;
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
  const [level, setLevel] = useState(0);
  const [inputDeviceId, setInputDeviceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.vg.settings.get().then((s) => {
      if (!cancelled) setInputDeviceId(s.audio.inputDeviceId ?? null);
    });
    const off = window.vg.settings.onChange((s) =>
      setInputDeviceId(s.audio.inputDeviceId ?? null),
    );
    return () => {
      cancelled = true;
      off();
    };
  }, []);

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

  // Capture lifecycle: a *fresh* AudioCapture per CAPTURING entry. Sharing
  // an instance across press/release cycles let leaked listeners fire on
  // subsequent sessions, and the .then() callback would attach listeners to
  // an already-stopped capture when start() raced with stop().
  useEffect(() => {
    if (state !== 'CAPTURING') {
      setLevel(0);
      return;
    }

    let cancelled = false;
    const cap = new AudioCapture();
    void cap
      .start({ deviceId: inputDeviceId ?? null })
      .then(() => {
        if (cancelled) {
          void cap.stop();
          return;
        }
        cap.onFrame((frame) => {
          const copy = new ArrayBuffer(frame.byteLength);
          new Uint8Array(copy).set(
            new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
          );
          window.vg.conversation.sendAudioFrame(copy);
        });
        cap.onLevel((rms) => {
          if (!cancelled) setLevel(rms);
        });
        cap.setMuted(false);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Não consegui aceder ao microfone: ${err.message}`);
      });

    return () => {
      cancelled = true;
      void cap.stop();
    };
  }, [state, inputDeviceId]);

  useEffect(() => {
    if (state === 'SPEAKING') {
      playback.beginUtterance('pcm16_22050');
    } else if (state === 'IDLE' || state === 'LISTENING_WAKE') {
      playback.endUtterance();
    }
  }, [state, playback]);

  return {
    state,
    transcript,
    connection,
    error,
    sttStatus,
    level,
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
