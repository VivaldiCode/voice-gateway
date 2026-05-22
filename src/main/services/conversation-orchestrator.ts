import { EventEmitter } from 'node:events';
import log from 'electron-log/main';
import type { HermesClient } from './hermes-client';
import type { SttAdapter } from './stt-service';
import type { TtsAdapter, TtsChunk } from './tts-service';
import {
  type ConversationContext,
  type ConversationEvent,
  type ReducerEnv,
  initialContext,
  reduce,
  defaultEnv,
} from '@shared/state-machine';
import type { ActivationMode, Settings } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

export interface OrchestratorEvents {
  state: (ctx: ConversationContext) => void;
  transcript_partial: (text: string, turnId: string) => void;
  transcript_final: (text: string, turnId: string) => void;
  response_text: (text: string, final: boolean, turnId: string) => void;
  tts_chunk: (chunk: TtsChunk, turnId: string) => void;
  error: (code: string, message: string) => void;
}

/**
 * Glue between the WS client, the STT/TTS adapters, and the conversation FSM.
 *
 * Owns the FSM context but never the actual audio I/O — audio capture and
 * playback live in the renderer; the orchestrator only sees PCM buffers
 * coming in (per turn) and pushes TTS chunks out.
 */
export class ConversationOrchestrator extends EventEmitter {
  private ctx: ConversationContext;
  private readonly env: ReducerEnv;
  private currentTurnAudio: Buffer[] = [];
  private currentLang: string | 'auto' = 'auto';
  private pendingTtsTurnId: string | null = null;
  private readonly onTtsChunk = (c: TtsChunk): void => {
    if (!this.pendingTtsTurnId) return;
    this.emit('tts_chunk', c, this.pendingTtsTurnId);
  };
  private readonly onTtsEnd = (): void => {
    this.pendingTtsTurnId = null;
    this.dispatch({ type: 'RESPONSE_END' });
  };
  private readonly onTtsError = (err: Error): void => {
    this.pendingTtsTurnId = null;
    this.emit('error', ERROR_CODES.TTS_FAILED, err.message);
    this.dispatch({ type: 'RESPONSE_END' });
  };

  constructor(
    private readonly client: HermesClient,
    private stt: SttAdapter,
    private tts: TtsAdapter,
    settings: Settings,
    env: ReducerEnv = defaultEnv,
  ) {
    super();
    this.env = env;
    this.ctx = initialContext(settings.activation.mode);
    this.currentLang = settings.stt.language;
    this.bindTts();
    this.bindClient();
  }

  // --- Public surface -----------------------------------------------------

  getState(): ConversationContext {
    return this.ctx;
  }

  setMode(mode: ActivationMode): void {
    this.dispatch({ type: 'SET_MODE', mode });
  }

  replaceSttAdapter(stt: SttAdapter): void {
    this.stt = stt;
  }

  replaceTtsAdapter(tts: TtsAdapter): void {
    this.unbindTts();
    this.tts = tts;
    this.bindTts();
  }

  /** Caller pressed the PTT button or global hotkey. */
  pttPress(): void {
    this.dispatch({ type: 'PTT_PRESS' });
  }

  /** Caller released the PTT button. Triggers STT + WS handoff. */
  pttRelease(): void {
    this.dispatch({ type: 'PTT_RELEASE' });
    void this.finishCurrentTurn();
  }

  /** Wake word fired (only honored in WAKE_WORD mode). */
  wakeDetected(): void {
    this.dispatch({ type: 'WAKE_DETECTED' });
  }

  /** VAD detected end of speech (wake-word flow). */
  vadSilence(): void {
    this.dispatch({ type: 'VAD_SILENCE' });
    void this.finishCurrentTurn();
  }

  /** Renderer is forwarding a captured PCM frame. */
  pushAudio(frame: Buffer | Uint8Array): void {
    if (this.ctx.state !== 'CAPTURING') return;
    this.currentTurnAudio.push(Buffer.isBuffer(frame) ? frame : Buffer.from(frame));
  }

  cancel(): void {
    this.dispatch({ type: 'USER_INTERRUPT', reason: 'cancel' });
    this.currentTurnAudio = [];
    this.tts.stop();
  }

  bargeIn(): void {
    // Order matters: dispatch first so any synchronous `end` event from a
    // stopped TTS adapter cannot prematurely walk the FSM out of SPEAKING.
    this.dispatch({ type: 'USER_INTERRUPT', reason: 'barge_in' });
    this.pendingTtsTurnId = null;
    this.tts.stop();
  }

  reset(): void {
    this.dispatch({ type: 'RESET' });
    this.tts.stop();
    this.currentTurnAudio = [];
  }

  setLanguage(lang: string | 'auto'): void {
    this.currentLang = lang;
  }

  // --- Internal -----------------------------------------------------------

  private dispatch(event: ConversationEvent): void {
    const next = reduce(this.ctx, event, this.env);
    if (next === this.ctx) return;
    this.ctx = next;
    this.emit('state', this.ctx);
  }

  private async finishCurrentTurn(): Promise<void> {
    const turnId = this.ctx.turnId;
    const audio = Buffer.concat(this.currentTurnAudio);
    this.currentTurnAudio = [];
    if (!turnId) return;

    let transcript = '';
    try {
      const r = await this.stt.transcribe({
        pcm: audio,
        language: (this.currentLang === 'auto' ? 'auto' : this.currentLang) as 'auto' | 'en' | 'pt',
      });
      transcript = r.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown STT error';
      log.warn('[VG] stt failed:', message);
      this.emit('error', ERROR_CODES.STT_FAILED, message);
      this.dispatch({ type: 'ERROR', code: ERROR_CODES.STT_FAILED, message });
      return;
    }

    this.emit('transcript_final', transcript, turnId);

    if (!transcript) {
      // No speech — bail to rest state without bothering Hermes.
      this.dispatch({ type: 'TRANSCRIPT_FINAL', text: '' });
      this.dispatch({ type: 'RESPONSE_END' });
      return;
    }

    this.dispatch({ type: 'TRANSCRIPT_FINAL', text: transcript });

    if (!this.client.isConnected()) {
      const msg = 'Sem ligação ao Hermes.';
      this.emit('error', ERROR_CODES.WS_DISCONNECTED, msg);
      this.dispatch({ type: 'ERROR', code: ERROR_CODES.WS_DISCONNECTED, message: msg });
      return;
    }

    // Tell the server we're starting a turn and send the transcript directly
    // (STT was on the client side). Server replies with response_text /
    // response_audio_chunk / response_end.
    this.client.sendStartTurn(turnId, this.currentLang === 'auto' ? undefined : this.currentLang);
    this.client.sendClientTranscript(turnId, transcript, true);
    this.client.sendEndTurn(turnId);
  }

  private bindClient(): void {
    this.client.on('thinking', () => {
      // FSM already in THINKING after TRANSCRIPT_FINAL; this is a no-op but kept
      // for symmetry / debugging.
    });
    this.client.on('response_text', (m) => {
      this.emit('response_text', m.text, m.final, m.turn_id);
      if (m.final && this.ctx.state === 'THINKING') {
        // Server has nothing more to say after this. If no audio comes, the
        // FSM stays in THINKING until response_end.
        void this.speak(m.text, m.turn_id);
      }
    });
    this.client.on('response_audio_chunk', (header, payload) => {
      // Server-side TTS: forward as if it were a local TTS chunk so the UI
      // playback layer handles both paths uniformly.
      this.dispatch({ type: 'RESPONSE_AUDIO_START' });
      this.emit('tts_chunk', { data: payload, format: 'pcm16_22050', seq: header.seq }, header.turn_id);
    });
    this.client.on('response_end', () => {
      this.dispatch({ type: 'RESPONSE_END' });
    });
    this.client.on('error', (m) => {
      this.emit('error', m.code, m.message);
      this.dispatch({ type: 'ERROR', code: m.code, message: m.message });
    });
  }

  private bindTts(): void {
    this.tts.on('chunk', this.onTtsChunk);
    this.tts.on('end', this.onTtsEnd);
    this.tts.on('error', this.onTtsError);
  }

  private unbindTts(): void {
    this.tts.off('chunk', this.onTtsChunk);
    this.tts.off('end', this.onTtsEnd);
    this.tts.off('error', this.onTtsError);
  }

  private async speak(text: string, turnId: string): Promise<void> {
    if (!text.trim()) {
      this.dispatch({ type: 'RESPONSE_END' });
      return;
    }
    try {
      this.dispatch({ type: 'RESPONSE_AUDIO_START' });
      this.pendingTtsTurnId = turnId;
      await this.tts.speak(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown TTS error';
      log.warn('[VG] tts failed:', message);
      this.emit('error', ERROR_CODES.TTS_FAILED, message);
      this.dispatch({ type: 'RESPONSE_END' });
    }
  }
}
