import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Cloud, HardDrive, Loader2, Mic, Headphones } from 'lucide-react';
import { Button } from './Button';
import { Logo } from './Logo';
import { cn } from '../lib/cn';
import { SUPPORTED_WAKE_WORDS, type WakeWord } from '../../shared/constants';
import type { ActivationMode, SttProvider, TtsProvider } from '../../shared/types';

type Step = 'url' | 'token' | 'mode' | 'providers' | 'done';

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
  // I6 round-12: user picks providers before reaching "done". Defaults
  // assume the safest no-extra-deps path for a fresh install — local
  // Piper is shipped as part of the macOS bundle, local Whisper auto-
  // installs via Homebrew on first use. The user can revert from
  // Settings → Voz / Reconhecimento any time.
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>('piper_local');
  const [sttProvider, setSttProvider] = useState<SttProvider>('whisper_local');
  const [probe, setProbe] = useState<ProbeState>({ testing: false, result: null });
  const [recentUrls, setRecentUrls] = useState<string[]>([]);
  // We seed the URL field from settings once on mount. Subsequent changes
  // are debounced back into settings.connection.draftUrl so a reload
  // resumes where the user left off.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    void window.vg.settings.get().then((s) => {
      const draft = s.connection?.draftUrl ?? '';
      const recents = s.connection?.recentUrls ?? [];
      const seed = draft.trim().length > 0 ? draft : (recents[0] ?? 'ws://');
      setUrl(seed);
      setRecentUrls(recents);
      seededRef.current = true;
    });
  }, []);
  // Debounced persistence of the URL draft so we don't thrash settings on
  // every keystroke. 400 ms is plenty to feel responsive without spamming.
  useEffect(() => {
    if (!seededRef.current) return;
    const handle = setTimeout(() => {
      void window.vg.settings.set({ connection: { draftUrl: url } });
    }, 400);
    return () => clearTimeout(handle);
  }, [url]);

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
    // I6 round-12: advance to the providers step (TTS + STT picker)
    // instead of jumping straight to 'done'. Lets the user pick
    // cloud vs local with cost/time estimates before they land in
    // the main view.
    setStep('providers');
  }, [url, token, mode, wakeWord]);

  // I6 round-12: persist the provider choice + kick off prepare() in
  // the background so the time-consuming local install (Piper venv,
  // whisper.cpp via brew, model download) is already in flight when
  // the user lands in the main view.
  const handleProvidersConfirm = useCallback(async () => {
    await window.vg.settings.set({
      tts: { provider: ttsProvider } as never,
      stt: { provider: sttProvider } as never,
    });
    if (ttsProvider === 'piper_local') void window.vg.tts.prepare();
    if (sttProvider === 'whisper_local') void window.vg.stt.prepare();
    setStep('done');
  }, [ttsProvider, sttProvider]);

  const cancelWizard = (): void => {
    // Wipe everything the user typed and return to step 1. Useful on
    // steps 2/3/4 if the user realises they pasted the wrong token or
    // picked the wrong activation mode / providers. Reviewer-spotted
    // nit on PR #12: previously this reset only token + mode and left
    // ttsProvider/sttProvider sticky between cancel cycles.
    setToken('');
    setMode('PUSH_TO_TALK');
    setTtsProvider('piper_local');
    setSttProvider('whisper_local');
    setProbe({ testing: false, result: null });
    setStep('url');
  };
  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="vg-drag flex items-center justify-center px-8 pt-9 pb-2">
        <Logo size={36} wordmark tagline="setup inicial" />
      </div>
      <Stepper current={step} />
      <main className="flex-1 overflow-y-auto px-8 pb-8 pt-4">
        {step === 'url' && (
          <UrlStep
            url={url}
            onUrl={setUrl}
            urlIsValid={urlIsValid}
            recentUrls={recentUrls}
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
        {step === 'providers' && (
          <ProvidersStep
            ttsProvider={ttsProvider}
            sttProvider={sttProvider}
            onTtsProvider={setTtsProvider}
            onSttProvider={setSttProvider}
            onBack={() => setStep('mode')}
            onConfirm={handleProvidersConfirm}
          />
        )}
        {step === 'done' && <DoneStep onContinue={onComplete} />}
      </main>
      {(step === 'token' || step === 'mode' || step === 'providers') && (
        <footer className="border-t border-bg-subtle px-8 py-3 text-center">
          <button
            type="button"
            onClick={cancelWizard}
            data-testid="wizard-cancel"
            className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
          >
            Cancelar configuração
          </button>
        </footer>
      )}
    </div>
  );
}

function Stepper({ current }: { current: Step }): JSX.Element {
  // I6 round-12: the wizard now has 4 user-facing steps (url, token,
  // mode, providers) plus the implicit 'done' page. The stepper shows
  // 4 dots; the "done" page renders without progress bars (it's the
  // celebration screen).
  const order: Step[] = ['url', 'token', 'mode', 'providers', 'done'];
  const index = order.indexOf(current);
  const totalSteps = 4;
  const displayIndex = current === 'done' ? totalSteps : index + 1;
  return (
    <div className="flex flex-col gap-2 px-8 pt-8" data-testid="wizard-stepper">
      <div className="flex items-center gap-2">
        {order.slice(0, totalSteps).map((s, i) => (
          <div
            key={s}
            className={cn(
              'h-1.5 flex-1 rounded-full transition',
              i <= index ? 'bg-accent' : 'bg-bg-panel',
            )}
            aria-current={i === index ? 'step' : undefined}
            data-active={i <= index ? 'true' : 'false'}
          />
        ))}
      </div>
      <p
        className="text-right text-[10px] uppercase tracking-wider text-zinc-500"
        data-testid="wizard-step-label"
      >
        passo {displayIndex} de {totalSteps}
      </p>
    </div>
  );
}

interface UrlStepProps {
  url: string;
  onUrl: (v: string) => void;
  urlIsValid: boolean;
  recentUrls: string[];
  onNext: () => void;
}

function UrlStep({ url, onUrl, urlIsValid, recentUrls, onNext }: UrlStepProps): JSX.Element {
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
          list="bridge-url-history"
          data-testid="url-input"
          className="h-12 rounded-xl border border-bg-subtle bg-bg-panel px-4 text-base text-white outline-none ring-accent/50 focus:border-accent focus:ring-2"
        />
        {/* Suggest the last few bridges this user has paired with so
            "I have two Hermes boxes" doesn't mean typing 30 chars twice. */}
        {recentUrls.length > 0 && (
          <datalist id="bridge-url-history" data-testid="bridge-url-history">
            {recentUrls.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        )}
        {!urlIsValid && url.length > 4 && (
          <span className="text-xs text-red-400">Tem de começar por ws:// ou wss://.</span>
        )}
        {recentUrls.length > 0 && (
          <div className="flex flex-wrap gap-2 text-[10px]" data-testid="recent-bridge-list">
            {recentUrls.map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => onUrl(u)}
                className="rounded-full bg-bg-panel px-2 py-1 text-zinc-400 transition hover:bg-bg-subtle hover:text-zinc-200"
                data-testid="recent-bridge-chip"
              >
                {u}
              </button>
            ))}
          </div>
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
          // install.sh prints the token inside a banner — copy/paste often
          // catches surrounding whitespace + a trailing newline. The probe
          // then fails with "token foi rejeitado" because the bridge does a
          // strict bytes compare. Strip all whitespace on every keystroke
          // so the field always reflects what'll actually be sent.
          onChange={(e) => onToken(e.target.value.replace(/\s+/g, ''))}
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

/**
 * I6 round-12 — TTS + STT provider picker.
 *
 * Two side-by-side cards (cloud vs local) per provider, with the
 * expected install time/effort surfaced up-front so the user can make
 * a sensible call. Defaults: Piper local + Whisper local (works offline
 * without any extra credentials). Cloud providers need API keys the
 * user enters later in Settings — the wizard just records the
 * preference here.
 */
interface ProvidersStepProps {
  ttsProvider: TtsProvider;
  sttProvider: SttProvider;
  onTtsProvider: (v: TtsProvider) => void;
  onSttProvider: (v: SttProvider) => void;
  onBack: () => void;
  onConfirm: () => void;
}

function ProvidersStep({
  ttsProvider,
  sttProvider,
  onTtsProvider,
  onSttProvider,
  onBack,
  onConfirm,
}: ProvidersStepProps): JSX.Element {
  return (
    <section
      className="mx-auto flex max-w-2xl flex-col gap-6"
      data-testid="wizard-providers"
    >
      <header>
        <h1 className="text-2xl font-semibold">Como queres que o Hermes ouça e fale?</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Local é privado e gratuito mas precisa de descarregar modelos.
          Cloud é instantâneo mas requer chaves API.
        </p>
      </header>

      <fieldset className="flex flex-col gap-3" data-testid="wizard-providers-tts">
        <legend className="text-xs uppercase tracking-wider text-zinc-500">
          Voz (TTS)
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <ProviderCard
            icon={<HardDrive className="h-6 w-6" />}
            title="Piper local"
            blurb="Voz natural, offline, ~30 MB por voz."
            timeEstimate="~1 min de download na primeira utilização"
            active={ttsProvider === 'piper_local'}
            onClick={() => onTtsProvider('piper_local')}
            testid="wizard-tts-local"
          />
          <ProviderCard
            icon={<Cloud className="h-6 w-6" />}
            title="ElevenLabs cloud"
            blurb="Vozes premium, latência baixa, requer chave API."
            timeEstimate="instantâneo (depois de adicionares a chave em Definições)"
            active={ttsProvider === 'elevenlabs'}
            onClick={() => onTtsProvider('elevenlabs')}
            testid="wizard-tts-cloud"
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3" data-testid="wizard-providers-stt">
        <legend className="text-xs uppercase tracking-wider text-zinc-500">
          Reconhecimento (STT)
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <ProviderCard
            icon={<HardDrive className="h-6 w-6" />}
            title="Whisper local"
            blurb="100% offline, instala-se via Homebrew."
            timeEstimate="~2–5 min na primeira execução (brew install + modelo base)"
            active={sttProvider === 'whisper_local'}
            onClick={() => onSttProvider('whisper_local')}
            testid="wizard-stt-local"
          />
          <ProviderCard
            icon={<Cloud className="h-6 w-6" />}
            title="OpenAI Whisper cloud"
            blurb="Pago por uso, requer chave API."
            timeEstimate="instantâneo (depois de adicionares a chave em Definições)"
            active={sttProvider === 'openai_whisper'}
            onClick={() => onSttProvider('openai_whisper')}
            testid="wizard-stt-cloud"
          />
        </div>
      </fieldset>

      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
        <Button
          size="lg"
          onClick={onConfirm}
          data-testid="wizard-providers-confirm"
        >
          Continuar
        </Button>
      </div>
    </section>
  );
}

interface ProviderCardProps {
  icon: JSX.Element;
  title: string;
  blurb: string;
  timeEstimate: string;
  active: boolean;
  onClick: () => void;
  testid: string;
}

function ProviderCard({
  icon,
  title,
  blurb,
  timeEstimate,
  active,
  onClick,
  testid,
}: ProviderCardProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testid}
      className={cn(
        'flex flex-col gap-2 rounded-2xl border bg-bg-panel p-4 text-left transition',
        active
          ? 'border-accent ring-2 ring-accent/40'
          : 'border-bg-subtle hover:border-zinc-600',
      )}
    >
      <span className="text-accent">{icon}</span>
      <span className="font-semibold text-white">{title}</span>
      <span className="text-xs text-zinc-400">{blurb}</span>
      <span className="text-[10px] uppercase tracking-wider text-accent-glow/80">
        {timeEstimate}
      </span>
    </button>
  );
}

function DoneStep({ onContinue }: { onContinue: () => void }): JSX.Element {
  return (
    <section
      className="mx-auto flex max-w-md flex-col items-center gap-6 pt-12 text-center"
      data-testid="pairing-done"
    >
      <Logo size={96} />
      <CheckCircle2 className="h-10 w-10 text-green-400" />
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
