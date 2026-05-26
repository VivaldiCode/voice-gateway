import { useEffect, useMemo, useState } from 'react';
import { Button } from './Button';
import { useT } from '../i18n';

/**
 * Post-pair interactive tutorial (round-12 I5).
 *
 * Shows once after the first successful pairing — a small series of
 * cards centered on screen that explain the basics: how to talk, the
 * keyboard shortcut, how to cancel, where Settings live. Designed to be
 * dismissible at any step ("Saltar tutorial") AND to never re-appear
 * unless the user explicitly resets it from Settings → Avançado.
 *
 * Intentionally NOT a tour-with-element-highlights — full element
 * spotlighting needs bounding-box math + window-resize listeners and
 * adds a lot of complexity for a one-time onboarding. A series of
 * centered cards with descriptive copy + a one-line "atalho" hint is
 * enough to teach the affordances; the user discovers the actual
 * positions by looking around the (small, minimal) window itself.
 *
 * The "Mostrar tutorial outra vez" button in Settings → Avançado flips
 * `settings.ui.tutorialSeen` back to false and closes Settings; the
 * tutorial re-appears next time the main window receives focus.
 */
export interface TutorialOverlayProps {
  /** Called when the user finishes the last step or hits "Saltar".
   *  The parent flips `settings.ui.tutorialSeen` to true. */
  onComplete: () => void;
  /** Optional override — defaults to the activation hotkey rendered in
   *  the same prettified form as MainScreen. */
  hotkey?: string;
}

interface Step {
  title: string;
  body: string;
  hint?: string;
}

export function TutorialOverlay({ onComplete, hotkey }: TutorialOverlayProps): JSX.Element {
  const t = useT();
  const [index, setIndex] = useState(0);
  // Read the active locale's dictionary once per render and assemble
  // the step list. Memoising on `t` keeps the array reference stable
  // across re-renders that don't flip the locale (so child renders
  // stay quiet) and rebuilds it on a live locale swap.
  const STEPS = useMemo<readonly Step[]>(
    () => [
      { title: t.tutorial.welcomeTitle, body: t.tutorial.welcomeBody },
      { title: t.tutorial.pressTitle, body: t.tutorial.pressBody, hint: t.tutorial.pressHint },
      { title: t.tutorial.cancelTitle, body: t.tutorial.cancelBody, hint: t.tutorial.cancelHint },
      { title: t.tutorial.settingsTitle, body: t.tutorial.settingsBody, hint: t.tutorial.settingsHint },
      { title: t.tutorial.doneTitle, body: t.tutorial.doneBody },
    ],
    [t],
  );
  const step = STEPS[index] ?? STEPS[0];
  const isLast = index === STEPS.length - 1;

  // Allow Escape to skip the tutorial — matches the rest of the app's
  // "Escape dismisses overlays" convention (CommandHint, error toast,
  // etc). Critical: call stopPropagation so MainScreen's own Escape
  // handler (which would cancel an in-flight turn) doesn't ALSO fire.
  // Reviewer-spotted nit, PR #11 round-12 — protects users who reopen
  // the tutorial via Settings while a turn is mid-CAPTURING.
  useEffect(() => {
    const w = globalThis as unknown as {
      addEventListener: (e: string, cb: (ev: { key: string; stopPropagation?: () => void }) => void, capture?: boolean) => void;
      removeEventListener: (e: string, cb: (ev: unknown) => void, capture?: boolean) => void;
    };
    const handler = (ev: { key: string; stopPropagation?: () => void }): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation?.();
        onComplete();
      }
    };
    // Capture phase so we run BEFORE MainScreen's listener (also on
    // window) sees the event.
    w.addEventListener('keydown', handler as (e: unknown) => void, true);
    return () => w.removeEventListener('keydown', handler as (e: unknown) => void, true);
  }, [onComplete]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vg-tutorial-title"
      data-testid="tutorial-overlay"
      data-step={String(index + 1)}
      data-step-total={String(STEPS.length)}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-bg-subtle bg-bg-panel p-6 shadow-2xl">
        <div className="flex items-center gap-1">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={[
                'h-1.5 flex-1 rounded-full transition',
                i <= index ? 'bg-accent' : 'bg-bg-subtle',
              ].join(' ')}
              aria-current={i === index ? 'step' : undefined}
            />
          ))}
        </div>
        <h2
          id="vg-tutorial-title"
          data-testid="tutorial-title"
          className="text-lg font-semibold text-white"
        >
          {step?.title}
        </h2>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
          {step?.body}
        </p>
        {step?.hint && (
          <p className="rounded-lg bg-bg-subtle px-3 py-2 text-xs text-zinc-400">
            {step.hint}
            {hotkey && index === 1 && (
              <span className="ml-1 font-mono text-accent-glow">{hotkey}</span>
            )}
          </p>
        )}
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={onComplete}
            data-testid="tutorial-skip"
            className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
          >
            {t.tutorial.skip}
          </button>
          <div className="flex gap-2">
            {index > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                data-testid="tutorial-back"
              >
                {t.tutorial.back}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => (isLast ? onComplete() : setIndex((i) => i + 1))}
              data-testid={isLast ? 'tutorial-done' : 'tutorial-next'}
            >
              {isLast ? t.tutorial.start : t.tutorial.next}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
