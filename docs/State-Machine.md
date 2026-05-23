# Conversation State Machine

The conversation FSM is a **pure reducer** in
[`src/shared/state-machine.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/shared/state-machine.ts).
Same `(context, event, env)` → same next context, no side effects, no
network, no audio.

That purity is the whole point. The orchestrator that drives it
(see [[Conversation-Orchestrator]]) deals with all the messy I/O and
asks the reducer "given my current state and this event, what's next?"
— so we can test every transition with `expect(reduce(ctx, ev)).toEqual(...)`
in isolation.

## States

```mermaid
stateDiagram-v2
    direction LR
    [*] --> IDLE
    [*] --> LISTENING_WAKE: mode = WAKE_WORD

    IDLE --> CAPTURING: PTT_PRESS
    LISTENING_WAKE --> CAPTURING: WAKE_DETECTED / PTT_PRESS

    CAPTURING --> STREAMING: PTT_RELEASE / VAD_SILENCE
    CAPTURING --> IDLE: USER_INTERRUPT(cancel) [mode=PTT]
    CAPTURING --> LISTENING_WAKE: USER_INTERRUPT(cancel) [mode=WAKE_WORD]

    STREAMING --> THINKING: TRANSCRIPT_FINAL

    THINKING --> SPEAKING: RESPONSE_AUDIO_START
    THINKING --> IDLE: RESPONSE_END [mode=PTT]
    THINKING --> LISTENING_WAKE: RESPONSE_END [mode=WAKE_WORD]

    SPEAKING --> IDLE: RESPONSE_END [mode=PTT]
    SPEAKING --> LISTENING_WAKE: RESPONSE_END [mode=WAKE_WORD]
    SPEAKING --> CAPTURING: USER_INTERRUPT(barge_in) / PTT_PRESS

    note right of ERROR
      ERROR is reachable from ANY state via the ERROR event.
      RESET → restState(mode)
      PTT_PRESS → CAPTURING (auto-recovery, clears lastError)
    end note

    IDLE --> ERROR: ERROR
    LISTENING_WAKE --> ERROR: ERROR
    CAPTURING --> ERROR: ERROR
    STREAMING --> ERROR: ERROR
    THINKING --> ERROR: ERROR
    SPEAKING --> ERROR: ERROR
    ERROR --> CAPTURING: PTT_PRESS
    ERROR --> IDLE: RESET [mode=PTT]
    ERROR --> LISTENING_WAKE: RESET [mode=WAKE_WORD]
```

| State            | Meaning                                              |
|------------------|------------------------------------------------------|
| `IDLE`           | Rest state in push-to-talk mode.                     |
| `LISTENING_WAKE` | Rest state in wake-word mode; runner is listening.   |
| `CAPTURING`      | Mic is open, accumulating audio for the current turn.|
| `STREAMING`      | Audio sent / transcript pending.                     |
| `THINKING`       | Bridge has acknowledged with `thinking`; waiting for assistant deltas. |
| `SPEAKING`       | TTS is playing back the response.                    |
| `ERROR`          | Sink state. Reachable from anywhere. Only `RESET` or `PTT_PRESS` can leave. |

## Events

| Event                                  | Triggers                                  |
|----------------------------------------|-------------------------------------------|
| `PTT_PRESS`                            | User pressed the call button or hotkey.   |
| `PTT_RELEASE`                          | User let go.                              |
| `WAKE_DETECTED`                        | openWakeWord fired (wake-word mode only). |
| `VAD_SILENCE`                          | (Reserved — VAD path not yet wired.)      |
| `TRANSCRIPT_FINAL { text }`            | STT finished; orchestrator hands the text to the FSM. |
| `RESPONSE_AUDIO_START`                 | First audio chunk of the assistant reply. |
| `RESPONSE_END`                         | Server sent `response_end`.               |
| `USER_INTERRUPT { reason }`            | `barge_in` (during SPEAKING) or `cancel` (during CAPTURING). |
| `ERROR { code, message }`              | Anything fatal anywhere in the pipeline.  |
| `RESET`                                | Manual reset from UI / IPC.               |
| `SET_MODE { mode }`                    | User switched between PTT and wake word.  |

## Context shape

```ts
interface ConversationContext {
  state: ConversationState;
  mode: ActivationMode;          // 'PUSH_TO_TALK' | 'WAKE_WORD'
  turnId: string | null;          // minted on PTT_PRESS / WAKE_DETECTED
  transcript: string | null;      // last user transcript
  lastError: { code: string; message: string } | null;
}
```

The "rest state" is computed from `mode`:

```ts
export function restState(mode: ActivationMode): ConversationState {
  return mode === 'WAKE_WORD' ? 'LISTENING_WAKE' : 'IDLE';
}
```

That's why `RESPONSE_END` in PTT mode goes to `IDLE` but in wake mode
goes back to `LISTENING_WAKE` — same FSM, mode-aware rest state.

## Determinism: the `ReducerEnv`

Turn IDs need to be unique-but-deterministic-in-tests. The reducer
takes an `env` parameter:

```ts
interface ReducerEnv {
  newTurnId: () => string;
}

export const defaultEnv: ReducerEnv = {
  newTurnId: () => globalThis.crypto.randomUUID(),
};

export function reduce(
  ctx: ConversationContext,
  event: ConversationEvent,
  env: ReducerEnv = defaultEnv,
): ConversationContext;
```

Tests inject a deterministic counter:

```ts
function makeEnv(): ReducerEnv {
  let n = 0;
  return { newTurnId: () => `turn-${++n}` };
}
```

so assertions like `expect(after.turnId).toBe('turn-2')` work
predictably across the whole test suite. See
[`tests/unit/state-machine.test.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/tests/unit/state-machine.test.ts).

## Tricky transitions, explained

### Barge-in during SPEAKING

```ts
case 'SPEAKING': {
  if (event.type === 'USER_INTERRUPT' && event.reason === 'barge_in') {
    return { ...ctx, state: 'CAPTURING',
             turnId: env.newTurnId(), transcript: null };
  }
  if (event.type === 'PTT_PRESS') {
    return { ...ctx, state: 'CAPTURING',
             turnId: env.newTurnId(), transcript: null };
  }
}
```

Both `USER_INTERRUPT(barge_in)` and `PTT_PRESS` while in `SPEAKING`
synthesise a new turn and capture immediately. The orchestrator
([[Conversation-Orchestrator#bargein]]) is careful to dispatch the FSM
event **before** stopping the TTS, because a TTS adapter that emits
`end` synchronously from `stop()` (some fake implementations did) would
race the FSM into `IDLE` and silently drop the barge-in.

### Cancel from CAPTURING

```ts
if (event.type === 'USER_INTERRUPT' && event.reason === 'cancel') {
  return { ...ctx, state: restState(ctx.mode),
           turnId: null, transcript: null };
}
```

A user-cancel returns to the rest state directly (no STT, no Hermes
call). The orchestrator clears the audio buffer at the same moment.

### Error recovery via PTT

```ts
case 'ERROR': {
  if (event.type === 'PTT_PRESS') {
    return { ...ctx, state: 'CAPTURING',
             turnId: env.newTurnId(), transcript: null, lastError: null };
  }
  return ctx;
}
```

This single rule is the reason the UI doesn't need a separate "reset"
button after an error. When the user sees the red orb after, say, an
OpenAI 400, pressing the mic button starts a fresh turn AND clears the
error message. The `CallButton` `disabled` rule in
[`MainScreen.tsx`](https://github.com/VivaldiCode/voice-gateway/blob/main/src/renderer/components/MainScreen.tsx)
specifically excludes the ERROR state so this transition is actually
clickable:

```ts
disabled={
  conv.connection.status !== 'connected' ||
  (conv.sttStatus.state !== 'ready' && conv.state !== 'ERROR')
}
```

### Mode switching is only honoured while quiet

```ts
if (event.type === 'SET_MODE') {
  const isQuiet = ctx.state === 'IDLE'
               || ctx.state === 'LISTENING_WAKE'
               || ctx.state === 'ERROR';
  if (!isQuiet) return ctx;   // silently ignored mid-conversation
  return { mode: event.mode, state: restState(event.mode), ... };
}
```

Switching from PTT to wake-word while you're halfway through a turn
would be ambiguous; the FSM just ignores the event. The settings UI
makes that visible by disabling the mode toggle while a turn is
in-flight.

## Convenience helpers

```ts
export function isCapturing(ctx: ConversationContext): boolean {
  return ctx.state === 'CAPTURING';
}

export function isBusy(ctx: ConversationContext): boolean {
  return ctx.state === 'STREAMING'
      || ctx.state === 'THINKING'
      || ctx.state === 'SPEAKING';
}
```

The renderer uses these (via the FSM context that's broadcast over IPC)
to derive UI affordances — e.g. dim the call button while busy, hide
the transcript composer, etc.

## Tests

[`tests/unit/state-machine.test.ts`](https://github.com/VivaldiCode/voice-gateway/blob/main/tests/unit/state-machine.test.ts)
has 28 cases covering:

- Initial state per activation mode.
- Every valid transition listed in the diagram.
- Every invalid event in every state returns the *same context
  reference* (so consumers can `===` to detect no-ops).
- `RESET` from `ERROR` clears `lastError`, `turnId`, `transcript`.
- `PTT_PRESS` from `ERROR` is the auto-recovery path (since
  [commit `c11a1a8`](https://github.com/VivaldiCode/voice-gateway/commit/c11a1a8)).
- Mode switches are ignored mid-turn but honoured from `ERROR`.
- Turn IDs increment across consecutive turns.
- Transcript is cleared when a new turn starts.

If you add a new state or event, you almost certainly need 2-3 new
cases here.

## How the orchestrator uses it

```ts
// src/main/services/conversation-orchestrator.ts
private dispatch(event: ConversationEvent): void {
  const next = reduce(this.ctx, event, this.env);
  if (next === this.ctx) return;   // no-op transitions are referentially equal
  this.ctx = next;
  this.emit('state', this.ctx);    // broadcast to renderer over IPC
}
```

Every external event funnels through `dispatch()`. If the FSM decides
the event doesn't apply (returns the same context), no UI update fires.
This keeps the renderer's render loop tight.
