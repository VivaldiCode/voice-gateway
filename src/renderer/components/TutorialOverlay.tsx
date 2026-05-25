import { useEffect, useState } from 'react';
import { Button } from './Button';

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

const STEPS: readonly Step[] = [
  {
    title: 'Bem-vindo ao Voice Gateway 👋',
    body:
      'Em três ecrãs ensino-te o básico. Demora menos de 30 segundos e podes' +
      ' saltar quando quiseres.',
  },
  {
    title: 'Carrega no botão para falar',
    body:
      'O grande botão violeta no centro da janela é o teu microfone. Mantém' +
      ' premido enquanto falas e larga quando acabares — o Hermes responde' +
      ' em segundos.',
    hint: 'Em alternativa, usa o atalho global (configurado no setup).',
  },
  {
    title: 'O X cancela a meio',
    body:
      'Enquanto estás a falar, aparece um botão "×" pequenino ao lado do' +
      ' microfone. Carrega aí (ou prime Escape) para cancelar o turno sem' +
      ' enviar nada.',
    hint: 'Útil quando começas a dizer a coisa errada.',
  },
  {
    title: 'Tudo o resto vive em Definições',
    body:
      'Voz, microfone, palavra-chave, idioma, exportar conversa — tudo num' +
      ' painel acessível pelo ⚙ no canto. Atalho ⌘, abre directamente.',
    hint: 'Cmd+L limpa a conversa · Cmd+S exporta para ficheiro.',
  },
  {
    title: 'Pronto! Diz olá ao Hermes.',
    body:
      'Se mudares de ideias, podes voltar a abrir este tutorial em' +
      ' Definições → Avançado.',
  },
];

export function TutorialOverlay({ onComplete, hotkey }: TutorialOverlayProps): JSX.Element {
  const [index, setIndex] = useState(0);
  const step = STEPS[index] ?? STEPS[0];
  const isLast = index === STEPS.length - 1;

  // Allow Escape to skip the tutorial — matches the rest of the app's
  // "Escape dismisses overlays" convention (CommandHint, error toast, etc).
  useEffect(() => {
    const w = globalThis as unknown as {
      addEventListener: (e: string, cb: (ev: { key: string }) => void) => void;
      removeEventListener: (e: string, cb: (ev: unknown) => void) => void;
    };
    const handler = (ev: { key: string }): void => {
      if (ev.key === 'Escape') onComplete();
    };
    w.addEventListener('keydown', handler as (e: unknown) => void);
    return () => w.removeEventListener('keydown', handler as (e: unknown) => void);
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
            Saltar tutorial
          </button>
          <div className="flex gap-2">
            {index > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                data-testid="tutorial-back"
              >
                ← Anterior
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => (isLast ? onComplete() : setIndex((i) => i + 1))}
              data-testid={isLast ? 'tutorial-done' : 'tutorial-next'}
            >
              {isLast ? 'Começar' : 'Seguinte →'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
