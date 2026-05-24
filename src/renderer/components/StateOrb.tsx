import { cn } from '../lib/cn';

type State = 'IDLE' | 'LISTENING_WAKE' | 'CAPTURING' | 'STREAMING' | 'THINKING' | 'SPEAKING' | 'ERROR';

const TINT: Record<State, string> = {
  IDLE: 'bg-state-idle/40 ring-state-idle/30',
  LISTENING_WAKE: 'bg-state-listening/30 ring-state-listening/50',
  CAPTURING: 'bg-state-listening ring-state-listening/60',
  STREAMING: 'bg-state-thinking/70 ring-state-thinking/50',
  THINKING: 'bg-state-thinking ring-state-thinking/60',
  SPEAKING: 'bg-state-speaking ring-state-speaking/60',
  ERROR: 'bg-state-error ring-state-error/60',
};

const LABEL: Record<State, string> = {
  IDLE: 'Pronto.',
  LISTENING_WAKE: 'À escuta.',
  CAPTURING: 'A ouvir-te.',
  STREAMING: 'A transcrever.',
  THINKING: 'A pensar.',
  SPEAKING: 'A responder.',
  ERROR: 'Houve um problema.',
};

export interface StateOrbProps {
  state: State;
  /** Live mic RMS level (0..1). Only meaningful when state === 'CAPTURING'. */
  level?: number;
}

export function StateOrb({ state, level = 0 }: StateOrbProps): JSX.Element {
  const isActive = state !== 'IDLE' && state !== 'ERROR';
  // Capture mode: drive a halo whose size follows the live RMS. Heavy
  // smoothing — RMS jumps around a lot, and the eye needs steady motion.
  const capturing = state === 'CAPTURING';
  // 0..1 → scale 1.0 .. 1.55 (gentle but visible).
  const haloScale = capturing ? 1 + Math.min(0.55, level * 2.4) : 1;
  const haloOpacity = capturing ? Math.min(0.9, 0.25 + level * 4) : 0.0;

  return (
    <div
      className="flex flex-col items-center gap-4"
      aria-live="polite"
      data-testid="state-orb"
      data-state={state}
    >
      <div className="relative flex h-40 w-40 items-center justify-center">
        {/* Pulsing halo driven by mic RMS */}
        {capturing && (
          <div
            aria-hidden="true"
            className="absolute h-36 w-36 rounded-full bg-state-listening blur-md transition-all duration-75"
            style={{
              transform: `scale(${haloScale.toFixed(3)})`,
              opacity: haloOpacity.toFixed(2),
            }}
          />
        )}
        <div
          aria-hidden="true"
          className={cn(
            'relative h-32 w-32 rounded-full ring-8 transition-colors duration-500',
            TINT[state],
            isActive && !capturing && 'animate-orb-breathe',
          )}
        />
        {state === 'THINKING' && (
          <div
            aria-hidden="true"
            className="absolute h-40 w-40 animate-pulse-slow rounded-full border-2 border-state-thinking/40"
          />
        )}
      </div>
      <span className="text-sm text-zinc-300" data-testid="orb-label">
        {LABEL[state]}
        {capturing && level > 0.02 && (
          <span className="ml-2 inline-block h-2 w-12 align-middle rounded-full bg-bg-subtle overflow-hidden">
            <span
              className="block h-full bg-state-listening transition-all duration-75"
              style={{ width: `${Math.min(100, Math.round(level * 250))}%` }}
            />
          </span>
        )}
      </span>
    </div>
  );
}
