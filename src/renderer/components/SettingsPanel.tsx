import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Volume2, Mic2, Cable, Sliders, AlertTriangle, RefreshCw, Loader2, Play, Download } from 'lucide-react';
import { Button } from './Button';
import { CommandHint } from './CommandHint';
import { cn } from '../lib/cn';
import {
  SUPPORTED_WAKE_WORDS,
  SUPPORTED_WHISPER_MODELS,
  type WakeWord,
  type WhisperModel,
} from '../../shared/constants';
import type {
  ActivationMode,
  ElevenLabsConfig,
  Settings,
  SttProvider,
  TtsProvider,
  WakeMode,
} from '../../shared/types';
import { PIPER_VOICES } from '../../shared/piper-voices';
import {
  DEFAULT_TEST_TEXT,
  MAX_TEST_TEXT_LENGTH,
  canSubmitTestText,
  prepareTestText,
} from '../../shared/tts-test-text';
import {
  MAX_WAKE_PHRASE_CHARS,
  validateWakePhrase,
} from '../../shared/wake-phrase';
import type { SttStatus, TtsStatus, VoiceInfo } from '../global';
import { AudioPlayback, type PlaybackFormat } from '../lib/audio-playback';

type Tab = 'voz' | 'microfone' | 'reconhecimento' | 'ativacao' | 'conexao' | 'avancado';

export interface SettingsPanelProps {
  settings: Settings;
  onClose: () => void;
  onRePair: () => void;
  /** 'side' = legacy slide-in modal; 'window' = full-viewport in a dedicated BrowserWindow. */
  layout?: 'side' | 'window';
}

const TABS: { id: Tab; label: string; icon: typeof Volume2 }[] = [
  { id: 'voz', label: 'Voz', icon: Volume2 },
  { id: 'microfone', label: 'Microfone', icon: Mic2 },
  { id: 'reconhecimento', label: 'Reconhecimento', icon: Mic2 },
  { id: 'ativacao', label: 'Ativação', icon: Sliders },
  { id: 'conexao', label: 'Conexão', icon: Cable },
  { id: 'avancado', label: 'Avançado', icon: AlertTriangle },
];

export function SettingsPanel({
  settings,
  onClose,
  onRePair,
  layout = 'side',
}: SettingsPanelProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('voz');

  const body = (
    <div
      className={cn(
        'flex flex-col border-bg-subtle bg-bg-panel shadow-2xl',
        layout === 'window' ? 'h-full w-full' : 'h-full w-full max-w-md border-l',
      )}
      onClick={layout === 'side' ? (e) => e.stopPropagation() : undefined}
    >
      <header className="vg-drag flex items-center justify-between border-b border-bg-subtle pr-3 pt-4 pb-3 pl-[88px]">
        <h2 className="text-lg font-semibold">Definições</h2>
        <button
          type="button"
          onClick={onClose}
          className="vg-no-drag rounded px-2 py-1 text-sm text-zinc-400 hover:text-white"
          aria-label="Fechar"
        >
          fechar
        </button>
      </header>
      <nav className="flex shrink-0 flex-wrap gap-1 border-b border-bg-subtle px-3 py-2 text-xs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            data-testid={`tab-${id}`}
            className={cn(
              'flex items-center gap-2 rounded px-3 py-2 transition',
              tab === id ? 'bg-bg-subtle text-white' : 'text-zinc-400 hover:text-white',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-y-auto px-5 py-4">
        {tab === 'voz' && <VozTab settings={settings} />}
        {tab === 'microfone' && <MicrofoneTab settings={settings} />}
        {tab === 'reconhecimento' && <ReconhecimentoTab settings={settings} />}
        {tab === 'ativacao' && <AtivacaoTab settings={settings} />}
        {tab === 'conexao' && <ConexaoTab settings={settings} onRePair={onRePair} />}
        {tab === 'avancado' && <AvancadoTab />}
      </main>
    </div>
  );

  if (layout === 'window') {
    return (
      <div role="region" aria-label="Definições" className="h-full w-full bg-bg">
        {body}
      </div>
    );
  }
  return (
    <div
      role="dialog"
      aria-label="Definições"
      className="fixed inset-0 z-30 flex items-stretch justify-end bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      {body}
    </div>
  );
}

// ───────── Microfone ─────────

type MicStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

function MicrofoneTab({ settings }: { settings: Settings }): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    settings.audio.inputDeviceId ?? null,
  );
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(
    settings.audio.outputDeviceId ?? null,
  );
  const [needsPermission, setNeedsPermission] = useState(false);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<MicStatus>('unknown');
  const [outputTestState, setOutputTestState] = useState<'idle' | 'playing'>('idle');
  // Hold the running test capture across renders.
  const captureRef = useMemo(() => ({ current: null as Awaited<ReturnType<typeof openCapture>> | null }), []);

  const refreshMicStatus = useCallback(async () => {
    const s = await window.vg.audio.getMicStatus();
    setMicStatus(s);
    return s;
  }, []);

  const refreshDevices = useCallback(async (alreadyHavePermission = false): Promise<void> => {
    try {
      if (!alreadyHavePermission) {
        // Tickle permission first so labels populate.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === 'audioinput');
      const outputs = all.filter((d) => d.kind === 'audiooutput');
      setDevices(inputs);
      setOutputDevices(outputs);
      setNeedsPermission(inputs.every((d) => !d.label));
      setError(null);
    } catch (err) {
      setNeedsPermission(true);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshMicStatus();
    void refreshDevices(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestPermission = useCallback(async () => {
    setError(null);
    const ok = await window.vg.audio.requestMic();
    const status = await refreshMicStatus();
    if (ok && status === 'granted') {
      // Now that the OS said yes, repopulate labels.
      await refreshDevices();
    } else if (status === 'denied') {
      setError(
        'O macOS continua a recusar. Carrega "Abrir Definições do Sistema" abaixo e ativa a Voice Gateway na lista do Microfone.',
      );
    }
  }, [refreshMicStatus, refreshDevices]);

  const openOsSettings = useCallback(async () => {
    await window.vg.audio.openMicSettings();
  }, []);

  const persist = useCallback(
    (id: string | null) => {
      void window.vg.settings.set({
        audio: { ...settings.audio, inputDeviceId: id },
      });
    },
    [settings.audio],
  );

  const persistOutput = useCallback(
    (id: string | null) => {
      void window.vg.settings.set({
        audio: { ...settings.audio, outputDeviceId: id },
      });
    },
    [settings.audio],
  );

  /**
   * Play a short test tone on the selected output device. Uses an inline
   * AudioBufferSourceNode so we don't depend on a server round-trip or a
   * TTS adapter being ready. Honours the live setSinkId() path.
   */
  const playOutputTest = useCallback(async (): Promise<void> => {
    setOutputTestState('playing');
    try {
      const opts: { sinkId?: string } = selectedOutputId
        ? { sinkId: selectedOutputId }
        : {};
      // Construct with sinkId so the very first sample plays on the right
      // speaker — falling back to a bare AudioContext if the runtime rejects
      // the option (older Chromium).
      let ctx: AudioContext;
      try {
        ctx = new AudioContext(opts as AudioContextOptions);
      } catch {
        ctx = new AudioContext();
        const ctxWithSink = ctx as unknown as {
          setSinkId?: (id: string) => Promise<void>;
        };
        if (selectedOutputId && typeof ctxWithSink.setSinkId === 'function') {
          try {
            await ctxWithSink.setSinkId(selectedOutputId);
          } catch {
            // best-effort
          }
        }
      }
      const sampleRate = ctx.sampleRate;
      const seconds = 0.6;
      const buf = ctx.createBuffer(1, Math.floor(seconds * sampleRate), sampleRate);
      const ch = buf.getChannelData(0);
      // Soft 440 Hz tone with a tiny envelope so it doesn't click.
      for (let i = 0; i < ch.length; i++) {
        const t = i / sampleRate;
        const env = Math.min(1, t * 20) * Math.min(1, (seconds - t) * 20);
        ch[i] = Math.sin(2 * Math.PI * 440 * t) * 0.18 * env;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      await new Promise<void>((resolve) => {
        src.onended = () => resolve();
        window.setTimeout(resolve, (seconds + 0.3) * 1000);
      });
      void ctx.close();
    } catch (err) {
      setError(`Não consegui reproduzir o teste de saída: ${(err as Error).message}`);
    } finally {
      setOutputTestState('idle');
    }
  }, [selectedOutputId]);

  const startTest = useCallback(async () => {
    if (captureRef.current) return;
    setError(null);
    try {
      const cap = await openCapture(selectedId, (rms) => setLevel(rms));
      captureRef.current = cap;
      setTesting(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedId, captureRef]);

  const stopTest = useCallback(() => {
    void captureRef.current?.stop();
    captureRef.current = null;
    setTesting(false);
    setLevel(0);
  }, [captureRef]);

  useEffect(() => () => stopTest(), [stopTest]);

  return (
    <div className="flex flex-col gap-5">
      <Section title="Permissão do macOS">
        <MicPermissionCard
          status={micStatus}
          onRequest={requestPermission}
          onOpenSettings={openOsSettings}
        />
      </Section>

      <Section title="Microfone a usar">
        {needsPermission && micStatus !== 'denied' && (
          <CommandHint
            variant="info"
            message='Concede acesso ao microfone (botão "Pedir permissão" acima) para o macOS revelar os nomes dos dispositivos.'
          />
        )}
        <div className="flex gap-2">
          <select
            value={selectedId ?? ''}
            onChange={(e) => {
              const v = e.target.value || null;
              setSelectedId(v);
              persist(v);
              if (testing) {
                stopTest();
                setTimeout(() => void startTest(), 50);
              }
            }}
            className="h-10 flex-1 rounded-xl border border-bg-subtle bg-bg px-2 text-sm text-white focus:border-accent focus:outline-none"
          >
            <option value="">Predefinido do sistema</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Dispositivo ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="md"
            onClick={() => void refreshDevices()}
            aria-label="Recarregar lista"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        {error && <CommandHint message={error} variant="error" />}
      </Section>

      <Section title="Testa o teu microfone">
        <p className="text-xs text-zinc-500">
          Fala normalmente. A barra deve mexer com a tua voz; se ficar parada,
          escolhe outro microfone na lista acima.
        </p>
        <VuMeter level={level} active={testing} />
        <div className="flex gap-2">
          {testing ? (
            <Button variant="danger" onClick={stopTest} data-testid="mic-stop-test">
              Parar
            </Button>
          ) : (
            <Button onClick={() => void startTest()} data-testid="mic-start-test">
              <Play className="mr-1 h-4 w-4" />
              Começar teste
            </Button>
          )}
        </div>
        {error && (
          <p
            role="alert"
            data-testid="mic-test-error"
            className="text-xs text-red-300"
          >
            {error}
          </p>
        )}
      </Section>

      <Section title="Saída de áudio (coluna)">
        <p className="text-xs text-zinc-500">
          Escolhe por onde queres ouvir a voz do agente. A mudança aplica-se
          já — não é preciso reiniciar.
        </p>
        <div className="flex gap-2">
          <select
            value={selectedOutputId ?? ''}
            onChange={(e) => {
              const v = e.target.value || null;
              setSelectedOutputId(v);
              persistOutput(v);
            }}
            aria-label="Dispositivo de saída"
            data-testid="output-device-select"
            className="h-10 flex-1 rounded-xl border border-bg-subtle bg-bg px-2 text-sm text-white focus:border-accent focus:outline-none"
          >
            <option value="">Predefinido do sistema</option>
            {outputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Saída ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="md"
            onClick={() => void refreshDevices()}
            aria-label="Recarregar lista de saídas"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="md"
            onClick={() => void playOutputTest()}
            disabled={outputTestState === 'playing'}
            data-testid="output-test-button"
          >
            <Play className="mr-1 h-4 w-4" />
            {outputTestState === 'playing' ? 'A reproduzir…' : 'Testar saída'}
          </Button>
          <span className="text-xs text-zinc-500">
            Um bipe curto (440&nbsp;Hz, ~0.6&nbsp;s) na saída escolhida.
          </span>
        </div>
        {outputDevices.length === 0 && !needsPermission && (
          <CommandHint
            variant="info"
            message="Não detectei saídas de áudio adicionais. Carrega o botão de recarregar depois de ligares colunas / auscultadores."
          />
        )}
      </Section>
    </div>
  );
}

function MicPermissionCard({
  status,
  onRequest,
  onOpenSettings,
}: {
  status: MicStatus;
  onRequest: () => void;
  onOpenSettings: () => void;
}): JSX.Element {
  const wrapper = (children: JSX.Element): JSX.Element => (
    <div data-testid="mic-permission" data-status={status}>
      {children}
    </div>
  );
  if (status === 'granted') {
    return wrapper(
      <div className="rounded-xl border border-green-800/60 bg-green-950/30 px-3 py-2 text-xs text-green-200">
        ✓ O macOS está a dar acesso ao microfone à Voice Gateway.
      </div>,
    );
  }
  if (status === 'denied' || status === 'restricted') {
    return wrapper(
      <div className="flex flex-col gap-2 rounded-xl border border-red-800 bg-red-950/40 px-3 py-3 text-xs text-red-100">

        <p>
          O macOS está a <strong>negar</strong> o microfone à Voice Gateway. A
          permissão tem de ser concedida no painel do Sistema — abre-o e ativa
          o toggle ao lado de <em>Voice Gateway</em>.
        </p>
        <Button size="sm" onClick={onOpenSettings}>
          Abrir Definições do Sistema
        </Button>
      </div>,
    );
  }
  if (status === 'not-determined') {
    return wrapper(
      <div className="flex flex-col gap-2 rounded-xl border border-yellow-800 bg-yellow-950/30 px-3 py-3 text-xs text-yellow-100">
        <p>O macOS ainda não pediu a tua autorização para o microfone.</p>
        <div className="flex gap-2">
          <Button size="sm" onClick={onRequest}>
            Pedir permissão agora
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenSettings}>
            Abrir Definições do Sistema
          </Button>
        </div>
      </div>,
    );
  }
  // unknown / non-mac
  return wrapper(
    <div className="rounded-xl border border-bg-subtle bg-bg-panel/60 px-3 py-2 text-xs text-zinc-300">
      Estado da permissão: <span className="font-mono">{status}</span>
    </div>,
  );
}

function VuMeter({ level, active }: { level: number; active: boolean }): JSX.Element {
  // Visual mapping: RMS often peaks around 0.1-0.3 for normal speech.
  const pct = Math.min(100, Math.round(level * 240));
  return (
    <div
      className="flex flex-col gap-1"
      data-testid="vu-meter"
      data-level={level.toFixed(4)}
      data-active={active ? '1' : '0'}
    >
      <div className="relative h-4 w-full overflow-hidden rounded-full bg-bg-subtle">
        <div
          className={cn(
            'h-full transition-all duration-75',
            active
              ? pct > 80
                ? 'bg-red-500'
                : pct > 50
                  ? 'bg-yellow-400'
                  : 'bg-state-listening'
              : 'bg-bg-subtle',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] uppercase tracking-wider text-zinc-500">
        <span>silêncio</span>
        <span>fala normal</span>
        <span>alto</span>
      </div>
    </div>
  );
}

async function openCapture(
  deviceId: string | null,
  onLevel: (rms: number) => void,
): Promise<{ stop: () => Promise<void> }> {
  // Late import to keep AudioCapture out of the SSR/transform path of tests.
  const { AudioCapture } = await import('../lib/audio-capture');
  const cap = new AudioCapture();
  await cap.start({ deviceId: deviceId ?? null });
  cap.onLevel(onLevel);
  return {
    stop: async () => {
      try {
        await cap.stop();
      } catch {
        // ignore
      }
    },
  };
}

// ───────── Voz ─────────

function VozTab({ settings }: { settings: Settings }): JSX.Element {
  const [provider, setProvider] = useState<TtsProvider>(settings.tts.provider);
  const [elKey, setElKey] = useState(settings.tts.elevenlabs.apiKey);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voiceId, setVoiceId] = useState(settings.tts.elevenlabs.voiceId);
  const [piperVoiceId, setPiperVoiceId] = useState(settings.tts.piper.modelId);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testText, setTestText] = useState('');
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ state: 'idle' });
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const off = window.vg.tts.onStatus(setTtsStatus);
    return off;
  }, []);

  type TtsPatch = {
    provider?: TtsProvider;
    elevenlabs?: Partial<ElevenLabsConfig>;
    piper?: { modelId?: string };
  };
  const persist = useCallback(
    (patch: TtsPatch) => {
      void window.vg.settings.set({
        tts: {
          ...settings.tts,
          ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
          elevenlabs: { ...settings.tts.elevenlabs, ...(patch.elevenlabs ?? {}) },
          piper: { ...settings.tts.piper, ...(patch.piper ?? {}) },
        },
      });
    },
    [settings.tts],
  );

  const downloadPiperVoice = useCallback(async () => {
    setDownloading(true);
    try {
      await window.vg.tts.prepare();
    } finally {
      setDownloading(false);
    }
  }, []);

  const loadVoices = useCallback(async () => {
    if (!elKey.trim()) {
      setVoicesError('Adiciona a chave API primeiro.');
      return;
    }
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      const r = await window.vg.tts.listVoices({ provider: 'elevenlabs', apiKey: elKey });
      if (!r.ok) {
        setVoicesError(r.message ?? 'Não consegui obter as vozes.');
        setVoices([]);
        return;
      }
      setVoices(r.voices);
      if (!voiceId && r.voices[0]) {
        setVoiceId(r.voices[0].id);
      }
    } finally {
      setLoadingVoices(false);
    }
  }, [elKey, voiceId]);

  const testPlayback = useMemo(() => new AudioPlayback(), []);
  useEffect(() => () => void testPlayback.dispose(), [testPlayback]);

  useEffect(() => {
    const off = window.vg.tts.onTestChunk((c) => {
      if (c.done) {
        testPlayback.endUtterance();
        return;
      }
      const bytes = base64ToBytes(c.data);
      testPlayback.pushChunk(bytes, c.format as PlaybackFormat);
    });
    return off;
  }, [testPlayback]);

  const onTest = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    // Sanitise the user-typed text: trim, collapse internal whitespace, cap
    // to MAX_TEST_TEXT_LENGTH, and fall back to DEFAULT_TEST_TEXT if the
    // textarea is empty. See prepareTestText (shared/tts-test-text.ts).
    const spoken = prepareTestText(testText);
    // Initialise playback inside the user-gesture stack so the AudioContext
    // is allowed to resume; the format is overridden mid-stream anyway if
    // the actual chunks declare something different.
    testPlayback.beginUtterance(provider === 'elevenlabs' ? 'mp3' : 'pcm16_22050');
    try {
      const r = await window.vg.tts.test({
        provider,
        text: spoken,
        elevenlabs:
          provider === 'elevenlabs'
            ? { ...settings.tts.elevenlabs, apiKey: elKey, voiceId }
            : undefined,
        piperVoiceId: provider === 'piper_local' ? piperVoiceId : undefined,
      });
      if (!r.ok) setTestError(r.message ?? 'Falhou.');
    } finally {
      setTesting(false);
    }
  }, [provider, elKey, voiceId, piperVoiceId, settings.tts.elevenlabs, testPlayback, testText]);

  return (
    <div className="flex flex-col gap-5">
      <Section title="Como queres ouvir o Hermes">
        <ProviderToggle
          options={[
            { id: 'piper_local', label: 'Piper (local, grátis)', sub: 'qualidade simples, funciona offline' },
            { id: 'elevenlabs', label: 'ElevenLabs (cloud)', sub: 'voz muito natural, requer chave' },
          ]}
          value={provider}
          onChange={(v) => {
            const p = v as TtsProvider;
            setProvider(p);
            persist({ provider: p });
          }}
        />
      </Section>

      {provider === 'piper_local' && (
        <>
          <Section title="Voz Piper">
            <select
              value={piperVoiceId}
              onChange={(e) => {
                setPiperVoiceId(e.target.value);
                persist({ piper: { modelId: e.target.value } });
              }}
              className="h-10 w-full rounded-xl border border-bg-subtle bg-bg px-2 text-sm text-white focus:border-accent focus:outline-none"
            >
              {PIPER_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} (~{v.sizeMb} MB)
                </option>
              ))}
            </select>
            <p className="text-xs text-zinc-500">
              A voz é descarregada da Hugging Face à primeira utilização e fica
              guardada localmente.
            </p>
          </Section>

          <Section title="Estado da voz">
            <PiperPrepareCard
              status={ttsStatus}
              downloading={downloading}
              onDownload={downloadPiperVoice}
            />
          </Section>
        </>
      )}

      {provider === 'elevenlabs' && (
        <>
          <Section title="Chave API da ElevenLabs">
            <input
              type="password"
              value={elKey}
              onChange={(e) => setElKey(e.target.value)}
              onBlur={() => persist({ elevenlabs: { apiKey: elKey } })}
              placeholder="sk_..."
              aria-label="Chave API"
              className="h-10 w-full select-text rounded-xl border border-bg-subtle bg-bg px-3 font-mono text-xs text-white outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
            />
            <p className="text-xs text-zinc-500">
              A chave fica gravada localmente.{' '}
              <a
                href="https://elevenlabs.io/app/settings/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                Cria uma aqui →
              </a>
            </p>
          </Section>

          <Section title="Voz">
            <div className="flex gap-2">
              <select
                value={voiceId}
                onChange={(e) => {
                  setVoiceId(e.target.value);
                  persist({ elevenlabs: { voiceId: e.target.value } });
                }}
                className="h-10 flex-1 rounded-xl border border-bg-subtle bg-bg px-2 text-sm text-white focus:border-accent focus:outline-none"
              >
                {voices.length === 0 && <option value="">(carrega as vozes)</option>}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.language ? ` — ${v.language}` : ''}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                size="md"
                onClick={loadVoices}
                loading={loadingVoices}
                aria-label="Recarregar vozes"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            {voicesError && <CommandHint message={voicesError} variant="error" />}
          </Section>
        </>
      )}

      <Section title="Testar voz">
        <div className="flex flex-col gap-2">
          <label
            htmlFor="vg-tts-test-text"
            className="text-xs uppercase tracking-wider text-zinc-500"
          >
            Texto a ler
          </label>
          <textarea
            id="vg-tts-test-text"
            data-testid="tts-test-text"
            value={testText}
            onChange={(e) => setTestText(e.target.value.slice(0, MAX_TEST_TEXT_LENGTH))}
            placeholder={DEFAULT_TEST_TEXT}
            maxLength={MAX_TEST_TEXT_LENGTH}
            rows={3}
            aria-label="Texto a ler"
            className="w-full resize-y rounded-xl border border-bg-subtle bg-bg px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {testText.trim().length === 0
                ? 'Vazio → será lido o texto de exemplo.'
                : 'O texto fica só aqui — não é enviado para o servidor.'}
            </span>
            <span data-testid="tts-test-char-count">
              {testText.length}/{MAX_TEST_TEXT_LENGTH}
            </span>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={onTest}
              loading={testing}
              size="md"
              data-testid="tts-test-button"
              disabled={
                !canSubmitTestText(testText) ||
                (provider === 'piper_local' && ttsStatus.state !== 'ready')
              }
            >
              <Play className="mr-1 h-4 w-4" />
              {testing ? 'a sintetizar…' : 'Reproduzir'}
            </Button>
            {testText.trim().length > 0 && (
              <button
                type="button"
                onClick={() => setTestText('')}
                className="text-xs text-zinc-400 hover:text-white"
                data-testid="tts-test-reset"
              >
                limpar
              </button>
            )}
          </div>
        </div>
        {testError && <CommandHint message={testError} variant="error" />}
      </Section>
    </div>
  );
}

function WhisperStatusCard({
  status,
  model,
}: {
  status: SttStatus;
  model: WhisperModel;
}): JSX.Element {
  const [checking, setChecking] = useState(false);
  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      await window.vg.stt.prepare();
    } finally {
      setChecking(false);
    }
  }, []);

  if (status.state === 'ready') {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-green-800/60 bg-green-950/30 px-3 py-2 text-xs text-green-200">
        <span>
          ✓ Whisper local pronto. Modelo <code>ggml-{model}.bin</code> descarregado.
        </span>
        <button
          type="button"
          onClick={recheck}
          className="vg-no-drag rounded p-1 text-zinc-300 hover:text-white"
          aria-label="Re-verificar"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  if (status.state === 'preparing') {
    const p = status.progress;
    const pct = p?.fraction != null ? Math.round(p.fraction * 100) : null;
    const label =
      p?.stage === 'installing'
        ? p.detail ?? 'a instalar dependências'
        : p?.stage === 'downloading'
          ? `a descarregar ggml-${model}.bin ${p.detail ? `(${p.detail})` : ''}`
          : 'a preparar reconhecimento';
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-bg-subtle bg-bg/60 px-3 py-2 text-xs text-zinc-300">
        <div className="flex items-center justify-between">
          <span>{label}…</span>
          {pct != null && <span className="font-mono text-accent">{pct}%</span>}
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-bg-subtle">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: pct != null ? `${pct}%` : '40%' }}
          />
        </div>
      </div>
    );
  }
  if (status.state === 'error') {
    return (
      <div className="flex flex-col gap-2">
        <CommandHint variant="error" message={status.message} />
        <Button onClick={recheck} loading={checking} size="sm" variant="secondary">
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Verificar de novo
        </Button>
      </div>
    );
  }
  // idle — main process is still starting up, or the user just changed
  // provider so prepareStt hasn't fired yet. Offer the same retry button
  // so a user who installed whisper-cpp just now can poke the discovery.
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-bg-subtle bg-bg-panel/60 px-3 py-2 text-xs text-zinc-300">
      <span>A inicializar…</span>
      <Button onClick={recheck} loading={checking} size="sm" variant="secondary">
        <RefreshCw className="mr-1 h-3.5 w-3.5" />
        Verificar agora
      </Button>
    </div>
  );
}

function PiperPrepareCard({
  status,
  downloading,
  onDownload,
}: {
  status: TtsStatus;
  downloading: boolean;
  onDownload: () => void;
}): JSX.Element {
  if (status.state === 'ready') {
    return (
      <div className="rounded-xl border border-green-800/60 bg-green-950/30 px-3 py-2 text-xs text-green-200">
        ✓ Voz Piper pronta. Carrega <em>Reproduzir amostra</em> abaixo para
        confirmar.
      </div>
    );
  }
  if (status.state === 'preparing') {
    const p = status.progress;
    const pct = p?.fraction != null ? Math.round(p.fraction * 100) : null;
    const label =
      p?.stage === 'installing'
        ? p.detail ?? 'a instalar dependências'
        : p?.stage === 'downloading'
          ? `a descarregar ${p.detail ?? 'voz'}`
          : 'a preparar voz';
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-bg-subtle bg-bg/60 px-3 py-2 text-xs text-zinc-300">
        <div className="flex items-center justify-between">
          <span>{label}…</span>
          {pct != null && <span className="font-mono text-accent">{pct}%</span>}
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-bg-subtle">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: pct != null ? `${pct}%` : '40%' }}
          />
        </div>
      </div>
    );
  }
  // idle or error
  return (
    <div className="flex flex-col gap-2">
      {status.state === 'error' && <CommandHint message={status.message} variant="error" />}
      <Button onClick={onDownload} loading={downloading}>
        <Download className="mr-1 h-4 w-4" />
        {status.state === 'error' ? 'Tentar de novo' : 'Descarregar voz agora'}
      </Button>
    </div>
  );
}

// ───────── Reconhecimento (STT) ─────────

function ReconhecimentoTab({ settings }: { settings: Settings }): JSX.Element {
  const [provider, setProvider] = useState<SttProvider>(settings.stt.provider);
  const [model, setModel] = useState<WhisperModel>(settings.stt.whisperLocal.model);
  const [language, setLanguage] = useState<string>(settings.stt.language);
  const [openaiKey, setOpenaiKey] = useState(settings.stt.openai.apiKey);
  const [sttStatus, setSttStatus] = useState<SttStatus>({ state: 'idle' });

  useEffect(() => {
    const off = window.vg.stt.onStatus(setSttStatus);
    return off;
  }, []);

  const persist = useCallback(
    (patch: Partial<Settings['stt']>) => {
      void window.vg.settings.set({
        stt: { ...settings.stt, ...patch } as Settings['stt'],
      });
    },
    [settings.stt],
  );

  return (
    <div className="flex flex-col gap-5">
      <Section title="Como queres que o Hermes te ouça">
        <ProviderToggle
          options={[
            { id: 'whisper_local', label: 'Whisper local (grátis)', sub: 'corre 100% no teu Mac' },
            { id: 'openai_whisper', label: 'OpenAI Whisper API', sub: 'sem instalar nada, requer chave' },
          ]}
          value={provider}
          onChange={(v) => {
            const p = v as SttProvider;
            setProvider(p);
            persist({ provider: p });
          }}
        />
      </Section>

      {provider === 'whisper_local' && (
        <>
          <Section title="Estado do reconhecimento">
            <WhisperStatusCard status={sttStatus} model={model} />
          </Section>

          <Section title="Modelo Whisper">
            <select
              value={model}
              onChange={(e) => {
                const m = e.target.value as WhisperModel;
                setModel(m);
                persist({ whisperLocal: { model: m } });
              }}
              className="h-10 w-full rounded-xl border border-bg-subtle bg-bg px-2 text-sm text-white focus:border-accent focus:outline-none"
            >
              {SUPPORTED_WHISPER_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}{' '}
                  {m === 'tiny'
                    ? '(~75 MB, mais rápido)'
                    : m === 'base'
                      ? '(~150 MB, recomendado)'
                      : '(~480 MB, mais preciso)'}
                </option>
              ))}
            </select>
            <p className="text-xs text-zinc-500">
              O modelo é descarregado automaticamente da Hugging Face na primeira vez.
            </p>
          </Section>
        </>
      )}

      {provider === 'openai_whisper' && (
        <Section title="Chave API da OpenAI">
          <input
            type="password"
            value={openaiKey}
            onChange={(e) => setOpenaiKey(e.target.value)}
            onBlur={() => persist({ openai: { ...settings.stt.openai, apiKey: openaiKey } })}
            placeholder="sk-..."
            aria-label="Chave API OpenAI"
            className="h-10 w-full select-text rounded-xl border border-bg-subtle bg-bg px-3 font-mono text-xs text-white outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
          />
          <p className="text-xs text-zinc-500">
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              Cria uma chave aqui →
            </a>
          </p>
        </Section>
      )}

      <Section title="Idioma">
        <select
          value={language}
          onChange={(e) => {
            setLanguage(e.target.value);
            persist({ language: e.target.value as 'pt' | 'en' | 'auto' });
          }}
          className="h-10 w-full rounded-xl border border-bg-subtle bg-bg px-2 text-sm text-white focus:border-accent focus:outline-none"
        >
          <option value="auto">Detetar automaticamente</option>
          <option value="pt">Português</option>
          <option value="en">English</option>
        </select>
      </Section>
    </div>
  );
}

// ───────── Ativação ─────────

function AtivacaoTab({ settings }: { settings: Settings }): JSX.Element {
  const [mode, setMode] = useState<ActivationMode>(settings.activation.mode);
  const [wakeMode, setWakeMode] = useState<WakeMode>(settings.activation.wakeMode ?? 'openww');
  const [wakeWord, setWakeWord] = useState<WakeWord>(settings.activation.wakeWord);
  const [wakePhrase, setWakePhrase] = useState(settings.activation.wakePhrase ?? 'hey hermes');
  const [hotkey, setHotkey] = useState(settings.activation.globalHotkey);
  const [minAudioMs, setMinAudioMs] = useState(settings.activation.minAudioMs ?? 300);

  const persist = useCallback(
    (patch: Partial<Settings['activation']>) => {
      void window.vg.settings.set({
        activation: { ...settings.activation, ...patch } as Settings['activation'],
      });
    },
    [settings.activation],
  );

  return (
    <div className="flex flex-col gap-5">
      <Section title="Modo de ativação">
        <ProviderToggle
          options={[
            { id: 'PUSH_TO_TALK', label: 'Botão para falar', sub: 'só ouve quando carregas' },
            { id: 'WAKE_WORD', label: 'Sempre à escuta', sub: 'palavra-chave (Hey Jarvis…)' },
          ]}
          value={mode}
          onChange={(v) => {
            const m = v as ActivationMode;
            setMode(m);
            persist({ mode: m });
          }}
        />
      </Section>

      {mode === 'WAKE_WORD' && (
        <>
          <Section title="Tipo de deteção">
            <ProviderToggle
              options={[
                {
                  id: 'openww',
                  label: 'Pré-definido',
                  sub: 'Hey Jarvis, Alexa, Computer… (CPU baixo)',
                },
                {
                  id: 'phrase',
                  label: 'Frase personalizada',
                  sub: 'usa o Whisper a escutar continuamente',
                },
              ]}
              value={wakeMode}
              onChange={(v) => {
                const m = v as WakeMode;
                setWakeMode(m);
                persist({ wakeMode: m });
              }}
            />
          </Section>

          {wakeMode === 'openww' && (
            <Section title="Palavra de ativação">
              <select
                value={wakeWord}
                onChange={(e) => {
                  const w = e.target.value as WakeWord;
                  setWakeWord(w);
                  persist({ wakeWord: w });
                }}
                className="h-10 w-full rounded-xl border border-bg-subtle bg-bg px-2 text-sm text-white focus:border-accent focus:outline-none"
              >
                {SUPPORTED_WAKE_WORDS.map((w) => (
                  <option key={w} value={w}>
                    {w.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              <WakeTester mode="openww" model={wakeWord} />
            </Section>
          )}

          {wakeMode === 'phrase' && (
            <Section title="Frase personalizada">
              <input
                type="text"
                value={wakePhrase}
                onChange={(e) => setWakePhrase(e.target.value.slice(0, MAX_WAKE_PHRASE_CHARS))}
                onBlur={() => {
                  const v = validateWakePhrase(wakePhrase);
                  if (v.ok) persist({ wakePhrase });
                }}
                placeholder="hey hermes"
                maxLength={MAX_WAKE_PHRASE_CHARS}
                aria-label="Frase personalizada"
                data-testid="wake-phrase-input"
                className="h-10 w-full select-text rounded-xl border border-bg-subtle bg-bg px-3 text-sm text-white focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
              <PhraseValidationHint phrase={wakePhrase} />
              <p className="text-xs text-zinc-500">
                A app escuta continuamente em janelas de ~2&nbsp;s e usa o Whisper
                local para procurar a tua frase. Precisa de mais CPU do que o
                modo pré-definido.
              </p>
              <WakeTester mode="phrase" phrase={wakePhrase} language={settings.stt.language} />
            </Section>
          )}
        </>
      )}

      <Section title="Atalho global">
        <input
          type="text"
          value={hotkey}
          onChange={(e) => setHotkey(e.target.value)}
          onBlur={() => persist({ globalHotkey: hotkey })}
          aria-label="Atalho global"
          className="h-10 w-full select-text rounded-xl border border-bg-subtle bg-bg px-3 font-mono text-xs text-white focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
        <p className="text-xs text-zinc-500">
          Formato Electron, ex: <code className="select-all rounded bg-black/40 px-1">CommandOrControl+Shift+H</code>.
          Aplica-se ao guardar (perde foco).
        </p>
      </Section>

      <Section title="Duração mínima da captura">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={50}
            max={1500}
            step={50}
            value={minAudioMs}
            onChange={(e) => setMinAudioMs(Number(e.target.value))}
            onMouseUp={() => persist({ minAudioMs })}
            onTouchEnd={() => persist({ minAudioMs })}
            aria-label="Duração mínima da captura em milissegundos"
            className="flex-1 accent-accent"
          />
          <span className="w-20 text-right font-mono text-xs text-white">
            {minAudioMs} ms
          </span>
        </div>
        <p className="text-xs text-zinc-500">
          Cliques mais curtos que isto são ignorados em vez de irem ao
          reconhecimento de voz — evita o erro &ldquo;audio too short&rdquo; quando
          tocas no botão sem querer. Padrão: 300&nbsp;ms.
        </p>
      </Section>
    </div>
  );
}

function PhraseValidationHint({ phrase }: { phrase: string }): JSX.Element | null {
  const r = validateWakePhrase(phrase);
  if (r.ok) return null;
  return (
    <p className="text-xs text-amber-400" data-testid="wake-phrase-hint">
      {r.reason}
    </p>
  );
}

type WakeTesterProps =
  | { mode: 'openww'; model: string }
  | { mode: 'phrase'; phrase: string; language: string };

interface WakeTesterEvent {
  type: 'idle' | 'starting' | 'ready' | 'wake' | 'transcript' | 'error' | 'done';
  text?: string;
}

/** Reusable mini-UI: a "Testar" button + live status while a sandboxed
 *  wake-word runner is spinning. Stops itself after a 20 s window or on
 *  the first detection so we never leave a runner hanging in the background. */
function WakeTester(props: WakeTesterProps): JSX.Element {
  const [event, setEvent] = useState<WakeTesterEvent>({ type: 'idle' });
  const [transcript, setTranscript] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const off = window.vg.wake.onTestEvent((e) => {
      if (e.event === 'ready') setEvent({ type: 'ready' });
      else if (e.event === 'transcript') setTranscript(e.text);
      else if (e.event === 'wake') {
        setEvent({ type: 'wake', text: e.transcript ?? e.phrase ?? e.model ?? '' });
        window.vg.wake.testStop();
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      } else if (e.event === 'error') setError(e.message);
      else if (e.event === 'exit') {
        // Process exited without firing — treat as done if we weren't already wake.
        setEvent((cur) => (cur.type === 'wake' ? cur : { type: 'done' }));
      }
    });
    return () => {
      off();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // Stop any in-flight test if our props change (user switched modes mid-test).
  // `target` is the model name for openww or the phrase for the custom path —
  // either change should reset the tester.
  const target = props.mode === 'phrase' ? props.phrase : props.model;
  useEffect(() => {
    window.vg.wake.testStop();
    setEvent({ type: 'idle' });
    setTranscript('');
    setError(null);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [props.mode, target]);

  const phraseValid =
    props.mode === 'openww' ? true : validateWakePhrase(props.phrase).ok;

  const onTest = useCallback(async () => {
    setError(null);
    setTranscript('');
    setEvent({ type: 'starting' });
    const req =
      props.mode === 'openww'
        ? { mode: 'openww' as const, model: props.model }
        : { mode: 'phrase' as const, phrase: props.phrase, language: props.language };
    const r = await window.vg.wake.testStart(req);
    if (!r.ok) {
      setError(r.message ?? 'Falhou.');
      setEvent({ type: 'idle' });
      return;
    }
    // Auto-stop after 20 s if nothing fires.
    timerRef.current = window.setTimeout(() => {
      window.vg.wake.testStop();
      setEvent((cur) => (cur.type === 'wake' ? cur : { type: 'done' }));
      timerRef.current = null;
    }, 20_000);
  }, [props]);

  const onStop = useCallback(() => {
    window.vg.wake.testStop();
    setEvent({ type: 'idle' });
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const active = event.type !== 'idle' && event.type !== 'wake' && event.type !== 'done';

  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="wake-tester">
      <div className="flex items-center gap-2">
        {!active ? (
          <Button
            onClick={onTest}
            size="md"
            disabled={!phraseValid}
            data-testid="wake-test-button"
          >
            <Play className="mr-1 h-4 w-4" />
            Testar agora
          </Button>
        ) : (
          <Button
            onClick={onStop}
            size="md"
            variant="secondary"
            data-testid="wake-test-stop"
          >
            Parar
          </Button>
        )}
        <span className="text-xs text-zinc-400" data-testid="wake-test-status">
          {event.type === 'idle' && 'Pronto a testar.'}
          {event.type === 'starting' && 'A iniciar o detector…'}
          {event.type === 'ready' && 'À escuta — fala agora!'}
          {event.type === 'wake' && '✅ Detectei!'}
          {event.type === 'done' && '⌛ Tempo esgotado. Volta a clicar.'}
        </span>
      </div>
      {props.mode === 'phrase' && transcript && (
        <p className="font-mono text-[11px] text-zinc-500" data-testid="wake-test-transcript">
          ouvi: &ldquo;{transcript}&rdquo;
        </p>
      )}
      {event.type === 'wake' && event.text && (
        <p className="font-mono text-[11px] text-emerald-400">{event.text}</p>
      )}
      {error && <CommandHint message={error} variant="error" />}
    </div>
  );
}

// ───────── Conexão ─────────

function ConexaoTab({
  settings,
  onRePair,
}: {
  settings: Settings;
  onRePair: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <Section title="Bridge actual">
        <p className="font-mono text-xs text-zinc-300">{settings.pairing?.url ?? '(sem pairing)'}</p>
        <p className="break-all font-mono text-[10px] text-zinc-500">
          token: {settings.pairing?.token?.slice(0, 8)}…{settings.pairing?.token?.slice(-4)}
        </p>
      </Section>
      <Section title="Re-emparelhar">
        <p className="text-xs text-zinc-500">
          Apaga a pairing actual e reabre o assistente de configuração.
        </p>
        <Button variant="secondary" onClick={onRePair}>
          Re-emparelhar agora
        </Button>
      </Section>
    </div>
  );
}

// ───────── Avançado ─────────

function AvancadoTab(): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const onReset = useCallback(async () => {
    await window.vg.settings.reset();
    setConfirming(false);
    // Force a reload so the wizard appears.
    location.reload();
  }, []);
  return (
    <div className="flex flex-col gap-5">
      <Section title="Factory reset">
        <p className="text-xs text-zinc-500">
          Apaga todas as definições (pairing, chaves API, vozes) e volta ao estado inicial.
        </p>
        {!confirming ? (
          <Button
            variant="danger"
            onClick={() => setConfirming(true)}
            data-testid="factory-reset"
          >
            Apagar tudo
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={onReset}
              data-testid="factory-reset-confirm"
            >
              Sim, apagar
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
          </div>
        )}
      </Section>
    </div>
  );
}

// ───────── primitives ─────────

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

function ProviderToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string; sub?: string }[];
  value: T;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={cn(
            'flex flex-col gap-1 rounded-xl border bg-bg p-3 text-left transition',
            value === o.id
              ? 'border-accent ring-2 ring-accent/30'
              : 'border-bg-subtle hover:border-zinc-600',
          )}
        >
          <span className="text-sm font-medium text-white">{o.label}</span>
          {o.sub && <span className="text-xs text-zinc-400">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function _unused_loader(): typeof Loader2 {
  return Loader2;
}
