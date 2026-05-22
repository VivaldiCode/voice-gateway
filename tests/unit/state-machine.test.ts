import { describe, expect, it } from 'vitest';
import {
  type ConversationContext,
  type ConversationEvent,
  type ReducerEnv,
  initialContext,
  isBusy,
  isCapturing,
  reduce,
  restState,
} from '@shared/state-machine';

function makeEnv(): ReducerEnv {
  let n = 0;
  return { newTurnId: () => `turn-${++n}` };
}

function run(
  start: ConversationContext,
  events: ConversationEvent[],
  env = makeEnv(),
): ConversationContext {
  return events.reduce((ctx, ev) => reduce(ctx, ev, env), start);
}

describe('state-machine — initial state', () => {
  it('IDLE for push-to-talk mode by default', () => {
    const ctx = initialContext();
    expect(ctx.state).toBe('IDLE');
    expect(ctx.mode).toBe('PUSH_TO_TALK');
  });

  it('LISTENING_WAKE for wake-word mode', () => {
    const ctx = initialContext('WAKE_WORD');
    expect(ctx.state).toBe('LISTENING_WAKE');
  });

  it('restState helper returns correct value per mode', () => {
    expect(restState('PUSH_TO_TALK')).toBe('IDLE');
    expect(restState('WAKE_WORD')).toBe('LISTENING_WAKE');
  });
});

describe('state-machine — activation', () => {
  it('PTT_PRESS in IDLE transitions to CAPTURING with new turn id', () => {
    const env = makeEnv();
    const next = reduce(initialContext(), { type: 'PTT_PRESS' }, env);
    expect(next.state).toBe('CAPTURING');
    expect(next.turnId).toBe('turn-1');
  });

  it('PTT_PRESS in LISTENING_WAKE also transitions to CAPTURING', () => {
    const next = reduce(initialContext('WAKE_WORD'), { type: 'PTT_PRESS' }, makeEnv());
    expect(next.state).toBe('CAPTURING');
    expect(next.turnId).toBe('turn-1');
  });

  it('WAKE_DETECTED in LISTENING_WAKE transitions to CAPTURING', () => {
    const next = reduce(initialContext('WAKE_WORD'), { type: 'WAKE_DETECTED' }, makeEnv());
    expect(next.state).toBe('CAPTURING');
  });

  it('WAKE_DETECTED in IDLE (PTT mode) is ignored', () => {
    const ctx = initialContext('PUSH_TO_TALK');
    const next = reduce(ctx, { type: 'WAKE_DETECTED' }, makeEnv());
    expect(next).toBe(ctx);
  });
});

describe('state-machine — capture → streaming → thinking', () => {
  it('PTT_RELEASE in CAPTURING transitions to STREAMING', () => {
    const after = run(initialContext(), [{ type: 'PTT_PRESS' }, { type: 'PTT_RELEASE' }]);
    expect(after.state).toBe('STREAMING');
  });

  it('VAD_SILENCE in CAPTURING transitions to STREAMING (wake mode)', () => {
    const after = run(initialContext('WAKE_WORD'), [
      { type: 'WAKE_DETECTED' },
      { type: 'VAD_SILENCE' },
    ]);
    expect(after.state).toBe('STREAMING');
  });

  it('TRANSCRIPT_FINAL in STREAMING transitions to THINKING and stores text', () => {
    const after = run(initialContext(), [
      { type: 'PTT_PRESS' },
      { type: 'PTT_RELEASE' },
      { type: 'TRANSCRIPT_FINAL', text: 'olá hermes' },
    ]);
    expect(after.state).toBe('THINKING');
    expect(after.transcript).toBe('olá hermes');
  });

  it('user cancel in CAPTURING returns to rest state', () => {
    const after = run(initialContext('WAKE_WORD'), [
      { type: 'WAKE_DETECTED' },
      { type: 'USER_INTERRUPT', reason: 'cancel' },
    ]);
    expect(after.state).toBe('LISTENING_WAKE');
    expect(after.turnId).toBeNull();
  });
});

describe('state-machine — thinking → speaking → end', () => {
  it('RESPONSE_AUDIO_START in THINKING transitions to SPEAKING', () => {
    const after = run(initialContext(), [
      { type: 'PTT_PRESS' },
      { type: 'PTT_RELEASE' },
      { type: 'TRANSCRIPT_FINAL', text: 'x' },
      { type: 'RESPONSE_AUDIO_START' },
    ]);
    expect(after.state).toBe('SPEAKING');
  });

  it('RESPONSE_END in THINKING (text-only) returns to rest state', () => {
    const after = run(initialContext(), [
      { type: 'PTT_PRESS' },
      { type: 'PTT_RELEASE' },
      { type: 'TRANSCRIPT_FINAL', text: 'x' },
      { type: 'RESPONSE_END' },
    ]);
    expect(after.state).toBe('IDLE');
    expect(after.turnId).toBeNull();
  });

  it('RESPONSE_END in SPEAKING returns to rest state (wake mode)', () => {
    const after = run(initialContext('WAKE_WORD'), [
      { type: 'WAKE_DETECTED' },
      { type: 'VAD_SILENCE' },
      { type: 'TRANSCRIPT_FINAL', text: 'x' },
      { type: 'RESPONSE_AUDIO_START' },
      { type: 'RESPONSE_END' },
    ]);
    expect(after.state).toBe('LISTENING_WAKE');
  });
});

describe('state-machine — barge-in', () => {
  it('USER_INTERRUPT barge_in in SPEAKING goes back to CAPTURING with new turn', () => {
    const env = makeEnv();
    const after = run(
      initialContext(),
      [
        { type: 'PTT_PRESS' }, // turn-1
        { type: 'PTT_RELEASE' },
        { type: 'TRANSCRIPT_FINAL', text: 'x' },
        { type: 'RESPONSE_AUDIO_START' },
        { type: 'USER_INTERRUPT', reason: 'barge_in' }, // turn-2
      ],
      env,
    );
    expect(after.state).toBe('CAPTURING');
    expect(after.turnId).toBe('turn-2');
  });

  it('PTT_PRESS during SPEAKING also triggers barge-in', () => {
    const env = makeEnv();
    const after = run(
      initialContext(),
      [
        { type: 'PTT_PRESS' },
        { type: 'PTT_RELEASE' },
        { type: 'TRANSCRIPT_FINAL', text: 'x' },
        { type: 'RESPONSE_AUDIO_START' },
        { type: 'PTT_PRESS' },
      ],
      env,
    );
    expect(after.state).toBe('CAPTURING');
    expect(after.turnId).toBe('turn-2');
  });
});

describe('state-machine — errors', () => {
  it('ERROR from IDLE moves to ERROR with code/message', () => {
    const next = reduce(
      initialContext(),
      { type: 'ERROR', code: 'WS_DISCONNECTED', message: 'broken' },
      makeEnv(),
    );
    expect(next.state).toBe('ERROR');
    expect(next.lastError).toEqual({ code: 'WS_DISCONNECTED', message: 'broken' });
  });

  it('ERROR from SPEAKING also moves to ERROR', () => {
    const after = run(initialContext(), [
      { type: 'PTT_PRESS' },
      { type: 'PTT_RELEASE' },
      { type: 'TRANSCRIPT_FINAL', text: 'x' },
      { type: 'RESPONSE_AUDIO_START' },
      { type: 'ERROR', code: 'X', message: 'boom' },
    ]);
    expect(after.state).toBe('ERROR');
  });

  it('RESET from ERROR returns to rest state and clears error', () => {
    const after = run(initialContext('WAKE_WORD'), [
      { type: 'ERROR', code: 'X', message: 'y' },
      { type: 'RESET' },
    ]);
    expect(after.state).toBe('LISTENING_WAKE');
    expect(after.lastError).toBeNull();
    expect(after.turnId).toBeNull();
    expect(after.transcript).toBeNull();
  });

  it('events other than RESET in ERROR are ignored', () => {
    const errored = reduce(
      initialContext(),
      { type: 'ERROR', code: 'X', message: 'y' },
      makeEnv(),
    );
    const next = reduce(errored, { type: 'PTT_PRESS' }, makeEnv());
    expect(next.state).toBe('ERROR');
  });
});

describe('state-machine — mode switching', () => {
  it('SET_MODE in IDLE swaps mode and rest state', () => {
    const next = reduce(
      initialContext('PUSH_TO_TALK'),
      { type: 'SET_MODE', mode: 'WAKE_WORD' },
      makeEnv(),
    );
    expect(next.mode).toBe('WAKE_WORD');
    expect(next.state).toBe('LISTENING_WAKE');
  });

  it('SET_MODE while CAPTURING is ignored', () => {
    const env = makeEnv();
    const capturing = reduce(initialContext(), { type: 'PTT_PRESS' }, env);
    const next = reduce(capturing, { type: 'SET_MODE', mode: 'WAKE_WORD' }, env);
    expect(next).toBe(capturing);
  });

  it('SET_MODE from ERROR also works (and clears error)', () => {
    const ctx = run(initialContext(), [{ type: 'ERROR', code: 'X', message: 'y' }]);
    const next = reduce(ctx, { type: 'SET_MODE', mode: 'WAKE_WORD' }, makeEnv());
    expect(next.state).toBe('LISTENING_WAKE');
    expect(next.lastError).toBeNull();
  });
});

describe('state-machine — invariants', () => {
  it('unknown / inapplicable events in IDLE are no-ops (referential identity)', () => {
    const ctx = initialContext();
    expect(reduce(ctx, { type: 'PTT_RELEASE' }, makeEnv())).toBe(ctx);
    expect(reduce(ctx, { type: 'VAD_SILENCE' }, makeEnv())).toBe(ctx);
    expect(reduce(ctx, { type: 'RESPONSE_END' }, makeEnv())).toBe(ctx);
    expect(reduce(ctx, { type: 'TRANSCRIPT_FINAL', text: '' }, makeEnv())).toBe(ctx);
  });

  it('inapplicable events in CAPTURING are no-ops', () => {
    const env = makeEnv();
    const capturing = reduce(initialContext(), { type: 'PTT_PRESS' }, env);
    expect(reduce(capturing, { type: 'RESPONSE_AUDIO_START' }, env)).toBe(capturing);
    expect(reduce(capturing, { type: 'TRANSCRIPT_FINAL', text: 'x' }, env)).toBe(capturing);
    expect(reduce(capturing, { type: 'WAKE_DETECTED' }, env)).toBe(capturing);
  });

  it('isCapturing / isBusy helpers reflect state', () => {
    const env = makeEnv();
    expect(isCapturing(initialContext())).toBe(false);
    expect(isBusy(initialContext())).toBe(false);
    const capturing = reduce(initialContext(), { type: 'PTT_PRESS' }, env);
    expect(isCapturing(capturing)).toBe(true);
    expect(isBusy(capturing)).toBe(false);
    const streaming = reduce(capturing, { type: 'PTT_RELEASE' }, env);
    expect(isBusy(streaming)).toBe(true);
  });

  it('turn id changes between consecutive turns', () => {
    const env = makeEnv();
    const a = run(initialContext(), [{ type: 'PTT_PRESS' }], env);
    const b = run(
      a,
      [
        { type: 'PTT_RELEASE' },
        { type: 'TRANSCRIPT_FINAL', text: 'x' },
        { type: 'RESPONSE_END' },
        { type: 'PTT_PRESS' },
      ],
      env,
    );
    expect(a.turnId).toBe('turn-1');
    expect(b.turnId).toBe('turn-2');
  });

  it('transcript is cleared when a new turn starts', () => {
    const env = makeEnv();
    const finished = run(
      initialContext(),
      [
        { type: 'PTT_PRESS' },
        { type: 'PTT_RELEASE' },
        { type: 'TRANSCRIPT_FINAL', text: 'olá' },
        { type: 'RESPONSE_END' },
      ],
      env,
    );
    expect(finished.transcript).toBe('olá');
    const restarted = reduce(finished, { type: 'PTT_PRESS' }, env);
    expect(restarted.transcript).toBeNull();
  });
});
