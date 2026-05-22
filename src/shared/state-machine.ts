/**
 * Pure finite-state machine for a single conversation turn.
 *
 *   IDLE ─┐
 *         ├─ PTT_PRESS ──────────► CAPTURING ── PTT_RELEASE / VAD_SILENCE ──► STREAMING
 *   LISTENING_WAKE                                                                   │
 *         └─ WAKE_DETECTED ─────► CAPTURING                          TRANSCRIPT_FINAL│
 *                                                                                    ▼
 *                                                                                THINKING
 *                                                                                    │
 *                                                                  RESPONSE_AUDIO_START
 *                                                                                    ▼
 *                                          ◄─ USER_INTERRUPT(barge_in) ────── SPEAKING
 *                                          ◄─ PTT_PRESS (barge-in) ───────────  │
 *                                                                                ▼
 *                                                                          RESPONSE_END
 *                                                                                ▼
 *                                                                      restState(mode)
 *
 * - ERROR is a sink reachable from any state.
 * - RESET takes ERROR back to restState(mode) and clears transient fields.
 * - SET_MODE is only honored when no conversation is active.
 *
 * Pure: same (ctx, event, env) ⇒ same next ctx. No side effects.
 */

import type { ActivationMode } from './types';

export type ConversationState =
  | 'IDLE'
  | 'LISTENING_WAKE'
  | 'CAPTURING'
  | 'STREAMING'
  | 'THINKING'
  | 'SPEAKING'
  | 'ERROR';

export interface ConversationContext {
  state: ConversationState;
  mode: ActivationMode;
  turnId: string | null;
  transcript: string | null;
  lastError: { code: string; message: string } | null;
}

export type ConversationEvent =
  | { type: 'WAKE_DETECTED' }
  | { type: 'PTT_PRESS' }
  | { type: 'PTT_RELEASE' }
  | { type: 'VAD_SILENCE' }
  | { type: 'TRANSCRIPT_FINAL'; text: string }
  | { type: 'RESPONSE_AUDIO_START' }
  | { type: 'RESPONSE_END' }
  | { type: 'USER_INTERRUPT'; reason: 'barge_in' | 'cancel' }
  | { type: 'ERROR'; code: string; message: string }
  | { type: 'RESET' }
  | { type: 'SET_MODE'; mode: ActivationMode };

export type ConversationEventType = ConversationEvent['type'];

/**
 * Side-effect-free environment injected into the reducer. Tests pass a
 * deterministic id generator; production wires {@link defaultEnv} which uses
 * `crypto.randomUUID`.
 */
export interface ReducerEnv {
  newTurnId: () => string;
}

export const defaultEnv: ReducerEnv = {
  newTurnId: () => globalThis.crypto.randomUUID(),
};

export function restState(mode: ActivationMode): ConversationState {
  return mode === 'WAKE_WORD' ? 'LISTENING_WAKE' : 'IDLE';
}

export function initialContext(mode: ActivationMode = 'PUSH_TO_TALK'): ConversationContext {
  return {
    state: restState(mode),
    mode,
    turnId: null,
    transcript: null,
    lastError: null,
  };
}

export function reduce(
  ctx: ConversationContext,
  event: ConversationEvent,
  env: ReducerEnv = defaultEnv,
): ConversationContext {
  // ERROR and RESET are universal — handled before per-state logic.
  if (event.type === 'ERROR') {
    return {
      ...ctx,
      state: 'ERROR',
      lastError: { code: event.code, message: event.message },
    };
  }

  if (event.type === 'RESET') {
    return {
      mode: ctx.mode,
      state: restState(ctx.mode),
      turnId: null,
      transcript: null,
      lastError: null,
    };
  }

  if (event.type === 'SET_MODE') {
    const isQuiet =
      ctx.state === 'IDLE' || ctx.state === 'LISTENING_WAKE' || ctx.state === 'ERROR';
    if (!isQuiet) return ctx;
    return {
      mode: event.mode,
      state: restState(event.mode),
      turnId: null,
      transcript: null,
      lastError: null,
    };
  }

  switch (ctx.state) {
    case 'IDLE':
    case 'LISTENING_WAKE': {
      if (event.type === 'PTT_PRESS') {
        return { ...ctx, state: 'CAPTURING', turnId: env.newTurnId(), transcript: null };
      }
      if (event.type === 'WAKE_DETECTED' && ctx.state === 'LISTENING_WAKE') {
        return { ...ctx, state: 'CAPTURING', turnId: env.newTurnId(), transcript: null };
      }
      return ctx;
    }

    case 'CAPTURING': {
      if (event.type === 'PTT_RELEASE' || event.type === 'VAD_SILENCE') {
        return { ...ctx, state: 'STREAMING' };
      }
      if (event.type === 'USER_INTERRUPT' && event.reason === 'cancel') {
        return { ...ctx, state: restState(ctx.mode), turnId: null, transcript: null };
      }
      return ctx;
    }

    case 'STREAMING': {
      if (event.type === 'TRANSCRIPT_FINAL') {
        return { ...ctx, state: 'THINKING', transcript: event.text };
      }
      return ctx;
    }

    case 'THINKING': {
      if (event.type === 'RESPONSE_AUDIO_START') {
        return { ...ctx, state: 'SPEAKING' };
      }
      if (event.type === 'RESPONSE_END') {
        return { ...ctx, state: restState(ctx.mode), turnId: null };
      }
      return ctx;
    }

    case 'SPEAKING': {
      if (event.type === 'RESPONSE_END') {
        return { ...ctx, state: restState(ctx.mode), turnId: null };
      }
      if (event.type === 'USER_INTERRUPT' && event.reason === 'barge_in') {
        return { ...ctx, state: 'CAPTURING', turnId: env.newTurnId(), transcript: null };
      }
      if (event.type === 'PTT_PRESS') {
        return { ...ctx, state: 'CAPTURING', turnId: env.newTurnId(), transcript: null };
      }
      return ctx;
    }

    case 'ERROR': {
      // PTT acts as an implicit RESET + start: pressing the mic button after
      // any error should always get the user out of the dead-end and into a
      // new capture. Otherwise the orb stays red and clicks are no-ops.
      if (event.type === 'PTT_PRESS') {
        return {
          ...ctx,
          state: 'CAPTURING',
          turnId: env.newTurnId(),
          transcript: null,
          lastError: null,
        };
      }
      return ctx;
    }
  }
}

/** Convenience: returns true iff the FSM is currently in a "user-talking" state. */
export function isCapturing(ctx: ConversationContext): boolean {
  return ctx.state === 'CAPTURING';
}

/** Convenience: returns true iff a request to the server is in flight. */
export function isBusy(ctx: ConversationContext): boolean {
  return ctx.state === 'STREAMING' || ctx.state === 'THINKING' || ctx.state === 'SPEAKING';
}
