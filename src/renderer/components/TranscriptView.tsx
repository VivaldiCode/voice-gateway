import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn';
import { useT } from '../i18n';

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
  /**
   * Total number of turns in the conversation. May be larger than
   * `lines.length` when the parent only renders a recent window. Drives
   * the "N mensagens" counter so the user knows the conversation has
   * more history than what's currently visible.
   */
  totalTurns?: number;
  /**
   * Optional callbacks for the action bar that only appears once there's
   * at least one turn. Passing `undefined` hides the corresponding
   * button, which the parent uses to keep the empty state uncluttered.
   */
  onClear?: () => void;
  onCopy?: () => void;
}

export function TranscriptView({
  lines,
  activationMode = 'PUSH_TO_TALK',
  totalTurns,
  onClear,
  onCopy,
}: TranscriptViewProps): JSX.Element {
  const t = useT();
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines]);
  const emptyHint =
    activationMode === 'WAKE_WORD' ? t.transcript.emptyWake : t.transcript.emptyPtt;
  const visibleCount = totalTurns ?? lines.length;
  return (
    <div className="flex w-full max-w-md flex-col gap-1">
      {visibleCount > 0 && (
        <div className="flex items-center justify-between gap-2 px-1 text-[10px] text-zinc-500">
          <span data-testid="transcript-count">{t.transcript.nMessages(visibleCount)}</span>
          <div className="flex items-center gap-2">
            {onCopy && (
              <button
                type="button"
                className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 hover:bg-bg-subtle hover:text-zinc-200"
                onClick={onCopy}
                data-testid="transcript-copy"
                aria-label={t.transcript.copyAria}
              >
                {t.transcript.copy}
              </button>
            )}
            {onClear && (
              <button
                type="button"
                className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 hover:bg-bg-subtle hover:text-zinc-200"
                onClick={onClear}
                data-testid="transcript-clear"
                aria-label={t.transcript.clearAria}
              >
                {t.transcript.clear}
              </button>
            )}
          </div>
        </div>
      )}
      <div
        ref={scroller}
        className="flex max-h-44 w-full flex-col gap-2 overflow-y-auto rounded-2xl border border-bg-subtle bg-bg-panel/60 p-4 text-sm"
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
                {l.role === 'user' ? t.transcript.userPrefix : t.transcript.assistantPrefix}
              </span>
              {l.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
