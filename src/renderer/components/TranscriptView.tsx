import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn';

export interface TranscriptLine {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface TranscriptViewProps {
  lines: TranscriptLine[];
  /**
   * Tailors the empty-state hint to the user's activation mode. Defaults
   * to push-to-talk wording — the original behaviour.
   */
  activationMode?: 'PUSH_TO_TALK' | 'WAKE_WORD';
}

export function TranscriptView({ lines, activationMode = 'PUSH_TO_TALK' }: TranscriptViewProps): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines]);
  const emptyHint =
    activationMode === 'WAKE_WORD'
      ? 'Diz a palavra-chave ou usa o atalho para começar.'
      : 'Carrega no botão ou usa o atalho para começar.';
  return (
    <div
      ref={scroller}
      className="flex max-h-44 w-full max-w-md flex-col gap-2 overflow-y-auto rounded-2xl border border-bg-subtle bg-bg-panel/60 p-4 text-sm"
      data-testid="transcript"
    >
      {lines.length === 0 ? (
        <p className="text-center text-xs text-zinc-500" data-testid="transcript-empty">
          {emptyHint}
        </p>
      ) : (
        lines.map((l) => (
          <p
            key={l.id}
            className={cn(
              'whitespace-pre-wrap leading-snug',
              l.role === 'user' ? 'text-white' : 'text-accent-glow',
            )}
            data-testid={`transcript-${l.role}`}
          >
            <span className="mr-2 text-[10px] uppercase tracking-wider text-zinc-500">
              {l.role === 'user' ? 'tu' : 'hermes'}
            </span>
            {l.text}
          </p>
        ))
      )}
    </div>
  );
}
