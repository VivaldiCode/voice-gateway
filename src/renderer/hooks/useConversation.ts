import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioCapture } from '../lib/audio-capture';
import { AudioPlayback, type PlaybackFormat } from '../lib/audio-playback';
import type { TranscriptLine } from '../components/TranscriptView';
import type { SttStatus, TtsStatus } from '../global';

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
  /** 0 while connected; ≥1 while the WS client is retrying. */
  reconnectAttempt: number;
}

export interface ConversationApi {
  state: State;
  transcript: TranscriptLine[];
  connection: ConnectionDisplay;
  /** Sticky error — only cleared on RESET / next PTT_PRESS. */
  error: string | null;
  /** Transient warning (auto-clears after 4s). */
  warning: string | null;
  sttStatus: SttStatus;
  ttsStatus: TtsStatus;
  /** Mic input level in 0..1 (RMS). Only updated while capturing. */
  level: number;
  pressTalk: () => void;
  releaseTalk: () => void;
  cancel: () => void;
  bargeIn: () => void;
  /** Clear the local sticky error (e.g. via Escape key or the close button). */
  dismissError: () => void;
  /** Wipe the transcript list locally — keeps the FSM untouched. */
  clearTranscript: () => void;
  /** Whether TTS audio is currently muted at the renderer playback layer. */
  outputMuted: boolean;
  /** Flip mute. Persists in settings.audio.outputMuted. */
  setOutputMuted: (m: boolean) => void;
}

const INITIAL_CONNECTION: ConnectionDisplay = {
  status: 'disconnected',
  latencyMs: null,
  lastError: null,
  reconnectAttempt: 0,
};

export function useConversation(): ConversationApi {
  const [state, setState] = useState<State>('IDLE');
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [connection, setConnection] = useState<ConnectionDisplay>(INITIAL_CONNECTION);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [sttStatus, setSttStatus] = useState<SttStatus>({ state: 'idle' });
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ state: 'idle' });
  const [level, setLevel] = useState(0);
  const [inputDeviceId, setInputDeviceId] = useState<string | null>(null);
  const [outputDeviceId, setOutputDeviceId] = useState<string | null>(null);
  const [outputMuted, setOutputMutedState] = useState<boolean>(false);

  // We seed the transcript with whatever persisted from the last session
  // exactly ONCE on mount. Subsequent settings.onChange events should not
  // re-seed (the user may have already cleared things mid-session).
  const transcriptSeededRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void window.vg.settings.get().then((s) => {
      if (cancelled) return;
      setInputDeviceId(s.audio.inputDeviceId ?? null);
      setOutputDeviceId(s.audio.outputDeviceId ?? null);
      setOutputMutedState(Boolean(s.audio.outputMuted));
      if (!transcriptSeededRef.current) {
        transcriptSeededRef.current = true;
        const persisted = s.transcript?.recent ?? [];
        if (persisted.length > 0) {
          setTranscript(
            persisted.map((p) => ({ id: p.id, role: p.role, text: p.text })),
          );
        }
      }
    });
    const off = window.vg.settings.onChange((s) => {
      setInputDeviceId(s.audio.inputDeviceId ?? null);
      setOutputDeviceId(s.audio.outputDeviceId ?? null);
      setOutputMutedState(Boolean(s.audio.outputMuted));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Debounced persistence of the most recent transcript lines so a crash
  // or restart doesn't wipe the conversation. We only persist the last
  // MAX_PERSISTED_TRANSCRIPT_LINES — settings should stay small. The
  // 600 ms debounce avoids a write per chunk during fast streaming.
  const lastPersistedRef = useRef<string>('[]');
  useEffect(() => {
    if (!transcriptSeededRef.current) return;
    const handle = (globalThis as unknown as {
      setTimeout: (cb: () => void, ms: number) => number;
      clearTimeout: (h: number) => void;
    }).setTimeout(() => {
      const tail = transcript.slice(-20).map((l) => ({
        id: l.id,
        role: l.role,
        text: l.text,
      }));
      const serialised = JSON.stringify(tail);
      if (serialised === lastPersistedRef.current) return;
      lastPersistedRef.current = serialised;
      void window.vg.settings.set({ transcript: { recent: tail } });
    }, 600);
    return () => {
      (globalThis as unknown as { clearTimeout: (h: number) => void }).clearTimeout(handle);
    };
  }, [transcript]);

  const playback = useMemo(() => new AudioPlayback(), []);
  // The TTS chunk handler is registered once below; it needs a *live* read
  // of the mute flag rather than a closure capture from the first render.
  const mutedRef = useRef(outputMuted);
  useEffect(() => {
    mutedRef.current = outputMuted;
    // If the user flips mute mid-utterance, kill in-flight playback so they
    // don't have to wait out the rest of the buffer.
    if (outputMuted) playback.stop();
  }, [outputMuted, playback]);

  // Push the user-chosen output device into the playback layer whenever it
  // changes. Idempotent — repeated calls with the same id are cheap.
  useEffect(() => {
    playback.setOutputDevice(outputDeviceId);
  }, [playback, outputDeviceId]);

  useEffect(() => {
    const offState = window.vg.conversation.onState((s) => {
      setState(s.state as State);
      // Clear sticky error as soon as the FSM leaves ERROR (e.g. via the new
      // PTT-from-ERROR transition that recovers the user automatically).
      if (s.state !== 'ERROR') setError(null);
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
      // Mute is a renderer-side decision — the FSM still advances through
      // SPEAKING so the orchestrator's lifecycle stays the same; we just
      // refuse to push the audio buffers to the AudioContext.
      if (mutedRef.current) return;
      const bytes = base64ToBytes(m.data);
      playback.pushChunk(bytes, m.format as PlaybackFormat);
    });
    const offError = window.vg.conversation.onError((m) => setError(m.message));
    const offWarning = window.vg.conversation.onWarning((m) => {
      setWarning(m.message);
      window.setTimeout(() => setWarning((cur) => (cur === m.message ? null : cur)), 4_000);
    });
    const offConn = window.vg.conversation.onConnection((m) => {
      setConnection({
        status: m.status as ConnectionDisplay['status'],
        latencyMs: m.latencyMs,
        lastError: m.lastError,
        reconnectAttempt: m.reconnectAttempt ?? 0,
      });
    });
    // Pull the current snapshot immediately. Without this we wait up to one
    // ping interval (15 s) for the next heartbeat event if the WS already
    // connected before this hook mounted.
    void window.vg.conversation.getConnection().then((m) => {
      setConnection({
        status: m.status as ConnectionDisplay['status'],
        latencyMs: m.latencyMs,
        lastError: m.lastError,
        reconnectAttempt: m.reconnectAttempt ?? 0,
      });
    });
    const offHotkey = window.vg.conversation.onHotkey(() => {
      // The main process drives the FSM transitions; we just react to state.
    });
    const offStt = window.vg.stt.onStatus(setSttStatus);
    const offTtsStatus = window.vg.tts.onStatus(setTtsStatus);

    return () => {
      offState();
      offTranscript();
      offResponse();
      offTts();
      offError();
      offWarning();
      offConn();
      offHotkey();
      offStt();
      offTtsStatus();
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
    warning,
    sttStatus,
    ttsStatus,
    level,
    pressTalk: () => window.vg.conversation.pttPress(),
    releaseTalk: () => window.vg.conversation.pttRelease(),
    cancel: () => window.vg.conversation.cancel(),
    bargeIn: () => window.vg.conversation.bargeIn(),
    dismissError: () => setError(null),
    clearTranscript: () => {
      setTranscript([]);
      lastPersistedRef.current = '[]';
      void window.vg.settings.set({ transcript: { recent: [] } });
    },
    outputMuted,
    setOutputMuted: (m: boolean) => {
      // Optimistic local update — the settings.onChange listener will
      // converge on the same value once main echoes it back.
      setOutputMutedState(m);
      void window.vg.settings.set({ audio: { outputMuted: m } });
    },
  };
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
