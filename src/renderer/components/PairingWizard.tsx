import { useCallback, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Mic, Headphones } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../lib/cn';
import { SUPPORTED_WAKE_WORDS, type WakeWord } from '../../shared/constants';
import type { ActivationMode } from '../../shared/types';

type Step = 'url' | 'token' | 'mode' | 'done';

interface ProbeState {
  testing: boolean;
  result: { ok: boolean; message: string } | null;
}

const WAKE_WORD_LABELS: Record<WakeWord, string> = {
  hey_jarvis: '"Hey Jarvis"',
  alexa: '"Alexa"',
  hey_mycroft: '"Hey Mycroft"',
  hey_rhasspy: '"Hey Rhasspy"',
  computer: '"Computer"',
};

export interface PairingWizardProps {
  onComplete: () => void;
}

export function PairingWizard({ onComplete }: PairingWizardProps): JSX.Element {
  const [step, setStep] = useState<Step>('url');
  const [url, setUrl] = useState('ws://');
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<ActivationMode>('PUSH_TO_TALK');
  const [wakeWord, setWakeWord] = useState<WakeWord>('hey_jarvis');
  const [probe, setProbe] = useState<ProbeState>({ testing: false, result: null });

  const urlIsValid = useMemo(() => /^wss?:\/\/\S+/.test(url.trim()), [url]);

  const handleTest = useCallback(async () => {
    if (!urlIsValid || !token.trim()) return;
    setProbe({ testing: true, result: null });
    const r = await window.vg.pair.test({ url: url.trim(), token: token.trim() });
    setProbe({ testing: false, result: { ok: r.ok, message: r.message } });
  }, [url, token, urlIsValid]);

  const handleSave = useCallback(async () => {
    setProbe({ testing: true, result: null });
    const r = await window.vg.pair.save({ url: url.trim(), token: token.trim() });
    if (!r.ok) {
      setProbe({ testing: false, result: { ok: false, message: r.message } });
      return;
    }
    await window.vg.settings.set({
      activation: {
        mode,
        wakeWord,
        // Other fields filled by deep-merge with defaults.
      } as never,
    });
    setProbe({ testing: false, result: null });
    setStep('done');
  }, [url, token, mode, wakeWord]);

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <Stepper current={step} />
      <main className="flex-1 overflow-y-auto px-8 pb-8 pt-4">
        {step === 'url' && (
          <UrlStep
            url={url}
            onUrl={setUrl}
            urlIsValid={urlIsValid}
            onNext={() => setStep('token')}
          />
        )}
        {step === 'token' && (
          <TokenStep
            token={token}
            onToken={setToken}
            probe={probe}
            onTest={handleTest}
            onBack={() => setStep('url')}
            onNext={() => setStep('mode')}
          />
        )}
        {step === 'mode' && (
          <ModeStep
            mode={mode}
            wakeWord={wakeWord}
            onMode={setMode}
            onWakeWord={setWakeWord}
            onBack={() => setStep('token')}
            onSave={handleSave}
            saving={probe.testing}
            saveError={probe.result?.ok === false ? probe.result.message : null}
          />
        )}
        {step === 'done' && <DoneStep onContinue={onComplete} />}
      </main>
    </div>
  );
}

function Stepper({ current }: { current: Step }): JSX.Element {
  const order: Step[] = ['url', 'token', 'mode', 'done'];
  const index = order.indexOf(current);
  return (
    <div className="flex items-center gap-2 px-8 pt-8">
      {order.slice(0, 3).map((s, i) => (
        <div
          key={s}
          className={cn(
            'h-1.5 flex-1 rounded-full transition',
            i <= index ? 'bg-accent' : 'bg-bg-panel',
          )}
          aria-current={i === index ? 'step' : undefined}
        />
      ))}
    </div>
  );
}

interface UrlStepProps {
  url: string;
  onUrl: (v: string) => void;
  urlIsValid: boolean;
  onNext: () => void;
}

function UrlStep({ url, onUrl, urlIsValid, onNext }: UrlStepProps): JSX.Element {
  return (
    <section className="mx-auto flex max-w-md flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Onde está o teu Hermes?</h1>
        <p className="mt-2 text-sm text-zinc-400">
          O endereço foi mostrado no fim do <code>install.sh</code>. Costuma ser algo como
          <code className="ml-1">ws://192.168.1.10:8765</code>.
        </p>
      </header>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Endereço do bridge</span>
        <input
          type="text"
          inputMode="url"
          autoFocus
          value={url}
          onChange={(e) => onUrl(e.target.value)}
          placeholder="ws://hermes.casa.lan:8765"
          aria-label="Endereço do bridge"
          aria-invalid={!urlIsValid}
          className="h-12 rounded-xl border border-bg-subtle bg-bg-panel px-4 text-base text-white outline-none ring-accent/50 focus:border-accent focus:ring-2"
        />
        {!urlIsValid && url.length > 4 && (
          <span className="text-xs text-red-400">Tem de começar por ws:// ou wss://.</span>
        )}
      </label>
      <div className="flex justify-end">
        <Button size="lg" disabled={!urlIsValid} onClick={onNext} data-testid="url-next">
          Continuar
        </Button>
      </div>
    </section>
  );
}

interface TokenStepProps {
  token: string;
  onToken: (v: string) => void;
  probe: ProbeState;
  onTest: () => void;
  onBack: () => void;
  onNext: () => void;
}

function TokenStep({ token, onToken, probe, onTest, onBack, onNext }: TokenStepProps): JSX.Element {
  const tokenLooksValid = token.trim().length >= 16;
  return (
    <section className="mx-auto flex max-w-md flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Cola o token de pairing</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Também foi mostrado no fim do <code>install.sh</code>, na caixa destacada.
        </p>
      </header>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Token</span>
        <textarea
          value={token}
          onChange={(e) => onToken(e.target.value)}
          placeholder="cola aqui..."
          aria-label="Token de pairing"
          rows={3}
          className="min-h-[88px] resize-none rounded-xl border border-bg-subtle bg-bg-panel px-4 py-3 font-mono text-sm text-white outline-none ring-accent/50 focus:border-accent focus:ring-2"
        />
      </label>

      {probe.result && (
        <div
          role="status"
          className={cn(
            'rounded-xl border px-4 py-3 text-sm',
            probe.result.ok
              ? 'border-green-700 bg-green-950/40 text-green-200'
              : 'border-red-800 bg-red-950/40 text-red-200',
          )}
          data-testid="probe-result"
        >
          {probe.result.message}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={!tokenLooksValid || probe.testing}
            loading={probe.testing}
            onClick={onTest}
            data-testid="probe-test"
          >
            {probe.testing ? 'A testar…' : 'Testar ligação'}
          </Button>
          <Button
            size="lg"
            disabled={!probe.result?.ok}
            onClick={onNext}
            data-testid="token-next"
          >
            Continuar
          </Button>
        </div>
      </div>
    </section>
  );
}

interface ModeStepProps {
  mode: ActivationMode;
  wakeWord: WakeWord;
  onMode: (m: ActivationMode) => void;
  onWakeWord: (w: WakeWord) => void;
  onBack: () => void;
  onSave: () => void;
  saving: boolean;
  saveError: string | null;
}

function ModeStep({
  mode,
  wakeWord,
  onMode,
  onWakeWord,
  onBack,
  onSave,
  saving,
  saveError,
}: ModeStepProps): JSX.Element {
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Como queres falar com o Hermes?</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Podes mudar mais tarde a qualquer momento.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModeCard
          icon={<Mic className="h-7 w-7" />}
          title="Botão para falar"
          subtitle="Recomendado para começar."
          description="Clica num botão (ou usa o atalho global) para ligar o microfone."
          active={mode === 'PUSH_TO_TALK'}
          onClick={() => onMode('PUSH_TO_TALK')}
          testid="mode-ptt"
        />
        <ModeCard
          icon={<Headphones className="h-7 w-7" />}
          title="Sempre à escuta"
          subtitle="Chama o Hermes por nome."
          description="Diz uma palavra-passe para o ativar, como o 'Alexa' ou o 'Google'."
          active={mode === 'WAKE_WORD'}
          onClick={() => onMode('WAKE_WORD')}
          testid="mode-wake"
        />
      </div>

      {mode === 'WAKE_WORD' && (
        <label className="flex flex-col gap-2" data-testid="wake-word-row">
          <span className="text-sm font-medium">Palavra de ativação</span>
          <select
            value={wakeWord}
            onChange={(e) => onWakeWord(e.target.value as WakeWord)}
            aria-label="Palavra de ativação"
            className="h-11 rounded-xl border border-bg-subtle bg-bg-panel px-3 text-sm text-white focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            {SUPPORTED_WAKE_WORDS.map((w) => (
              <option key={w} value={w}>
                {WAKE_WORD_LABELS[w]}
              </option>
            ))}
          </select>
        </label>
      )}

      {saveError && (
        <div
          role="alert"
          className="rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200"
        >
          {saveError}
        </div>
      )}

      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
        <Button size="lg" loading={saving} onClick={onSave} data-testid="finish-pairing">
          {saving ? 'A gravar…' : 'Pronto!'}
        </Button>
      </div>
    </section>
  );
}

interface ModeCardProps {
  icon: JSX.Element;
  title: string;
  subtitle: string;
  description: string;
  active: boolean;
  onClick: () => void;
  testid: string;
}

function ModeCard({
  icon,
  title,
  subtitle,
  description,
  active,
  onClick,
  testid,
}: ModeCardProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testid}
      className={cn(
        'flex flex-col gap-3 rounded-2xl border bg-bg-panel p-5 text-left transition',
        active
          ? 'border-accent ring-2 ring-accent/40'
          : 'border-bg-subtle hover:border-zinc-600',
      )}
    >
      <span className="text-accent">{icon}</span>
      <span className="text-lg font-semibold">{title}</span>
      <span className="text-xs uppercase tracking-wider text-accent">{subtitle}</span>
      <span className="text-sm text-zinc-400">{description}</span>
    </button>
  );
}

function DoneStep({ onContinue }: { onContinue: () => void }): JSX.Element {
  return (
    <section
      className="mx-auto flex max-w-md flex-col items-center gap-6 pt-12 text-center"
      data-testid="pairing-done"
    >
      <CheckCircle2 className="h-16 w-16 text-green-400" />
      <h1 className="text-2xl font-semibold">Pronto! Diz olá ao Hermes.</h1>
      <p className="text-sm text-zinc-400">
        Podes ajustar voz, microfone e palavra de ativação nas definições.
      </p>
      <Button size="lg" onClick={onContinue} data-testid="open-app">
        Abrir Voice Gateway
      </Button>
    </section>
  );
}

export function _internals_useLoading(): typeof Loader2 {
  return Loader2;
}
