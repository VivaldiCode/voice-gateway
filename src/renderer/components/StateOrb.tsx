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
}

export function StateOrb({ state }: StateOrbProps): JSX.Element {
  const isActive = state !== 'IDLE' && state !== 'ERROR';
  return (
    <div className="flex flex-col items-center gap-4" aria-live="polite">
      <div className="relative flex h-40 w-40 items-center justify-center">
        <div
          aria-hidden="true"
          className={cn(
            'h-32 w-32 rounded-full ring-8 transition-colors duration-500',
            TINT[state],
            isActive && 'animate-orb-breathe',
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
      </span>
    </div>
  );
}
