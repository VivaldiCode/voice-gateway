import { Mic, MicOff } from 'lucide-react';
import { cn } from '../lib/cn';

export interface CallButtonProps {
  state: 'IDLE' | 'LISTENING_WAKE' | 'CAPTURING' | 'STREAMING' | 'THINKING' | 'SPEAKING' | 'ERROR';
  onPress: () => void;
  onRelease: () => void;
  disabled?: boolean;
}

const VARIANT: Record<CallButtonProps['state'], string> = {
  IDLE: 'bg-accent hover:bg-accent-glow',
  LISTENING_WAKE: 'bg-accent hover:bg-accent-glow',
  CAPTURING: 'bg-state-listening',
  STREAMING: 'bg-state-thinking opacity-80',
  THINKING: 'bg-state-thinking opacity-80',
  SPEAKING: 'bg-state-speaking',
  ERROR: 'bg-state-error',
};

export function CallButton({ state, onPress, onRelease, disabled }: CallButtonProps): JSX.Element {
  const active = state === 'CAPTURING';
  return (
    <button
      type="button"
      aria-label={active ? 'Largar para enviar' : 'Carregar para falar'}
      data-testid="call-button"
      disabled={disabled}
      onPointerDown={onPress}
      onPointerUp={onRelease}
      onPointerLeave={(e) => {
        if (e.buttons === 0) return;
        onRelease();
      }}
      className={cn(
        'flex h-16 w-16 items-center justify-center rounded-full text-white shadow-lg transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/50',
        VARIANT[state],
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {active ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
    </button>
  );
}
