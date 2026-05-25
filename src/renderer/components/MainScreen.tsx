import { useEffect, useRef, useState } from 'react';
import { Settings as SettingsIcon, Volume2 as VolumeOnIcon, VolumeX as VolumeOffIcon, X as XIcon } from 'lucide-react';
import { Button } from './Button';
import { CallButton } from './CallButton';
import { CommandHint } from './CommandHint';
import { Logo } from './Logo';
import { StateOrb } from './StateOrb';
import { TranscriptView } from './TranscriptView';
import { useConversation } from '../hooks/useConversation';
import { useAppStore } from '../store/app-store';
import { cn } from '../lib/cn';
import type { SttStatus, TtsStatus } from '../global';

/** Map FSM state → human-readable suffix shown in the window title bar. */
const TITLE_SUFFIX: Record<string, string> = {
  IDLE: 'Pronto',
  LISTENING_WAKE: 'À escuta',
  CAPTURING: 'A ouvir',
  STREAMING: 'A transcrever',
  THINKING: 'A pensar',
  SPEAKING: 'A responder',
  ERROR: 'Erro',
};

/** Why the call button is disabled — surfaced as a tooltip + sr-only text. */
function disabledReason(
  connectionStatus: string,
  sttState: string,
  ttsState: string,
  state: string,
): string | null {
  if (state === 'ERROR') return null; // explicitly clickable for auto-recovery
  if (connectionStatus !== 'connected') return 'Sem ligação ao Hermes';
  if (sttState === 'preparing') return 'Reconhecimento de voz a preparar…';
  if (sttState === 'error') return 'Reconhecimento de voz com erro — vê Definições';
  if (sttState !== 'ready') return 'Reconhecimento de voz ainda não pronto';
  if (ttsState === 'error') return 'Voz com erro — vê Definições';
  return null;
}

export interface MainScreenProps {
  bridgeUrl: string | null;
  onOpenSettings: () => void;
}

export function MainScreen({ bridgeUrl, onOpenSettings }: MainScreenProps): JSX.Element {
  const conv = useConversation();
  const settings = useAppStore((s) => s.settings);
  const activationMode = settings?.activation.mode ?? 'PUSH_TO_TALK';
  const globalHotkey = settings?.activation.globalHotkey ?? 'CommandOrControl+Shift+H';

  // Window title reflects FSM state — visible in Cmd+Tab / macOS Mission Control.
  useEffect(() => {
    const doc = globalThis as unknown as { document?: { title: string } };
    if (doc.document) {
      const suffix = TITLE_SUFFIX[conv.state] ?? 'Pronto';
      doc.document.title = `Voice Gateway — ${suffix}`;
    }
  }, [conv.state]);

  // Wake-word feedback flash: when state transitions LISTENING_WAKE →
  // CAPTURING (i.e. the runner just fired), nudge a transient "just woke"
  // class onto the orb wrapper so the user gets a brief visible
  // confirmation that the app heard them.
  const prevStateRef = useRef(conv.state);
  const [justWoke, setJustWoke] = useState(false);
  useEffect(() => {
    const prev = prevStateRef.current;
    // The renderer doesn't always observe LISTENING_WAKE as the "previous"
    // state because the orchestrator only emits 'state' on transitions, not
    // on construction — the very first event might already be CAPTURING
    // (the wake-detected dispatch). So we fire the flash whenever WE
    // transition INTO CAPTURING from anything other than CAPTURING itself
    // in WAKE_WORD mode. False positives in PTT-from-wake-mode are
    // harmless; the flash just confirms "we heard the trigger".
    if (
      activationMode === 'WAKE_WORD' &&
      prev !== 'CAPTURING' &&
      conv.state === 'CAPTURING'
    ) {
      setJustWoke(true);
      const handle = (globalThis as unknown as {
        setTimeout: (cb: () => void, ms: number) => number;
      }).setTimeout(() => setJustWoke(false), 600);
      prevStateRef.current = conv.state;
      return () => {
        (globalThis as unknown as { clearTimeout: (h: number) => void }).clearTimeout(handle);
      };
    }
    prevStateRef.current = conv.state;
    return;
  }, [conv.state, activationMode]);

  // Window-level keyboard shortcuts.
  // - Escape: dismiss the sticky error toast, OR if we're CAPTURING, cancel
  //   the in-flight turn so the user doesn't have to find a button.
  // - Cmd+,: open the Settings window — macOS standard shortcut.
  // - Cmd+L: wipe the transcript locally (a "new conversation").
  // - Cmd+R: only when in ERROR, dismiss + immediately retry by pressing
  //   PTT so the orchestrator's ERROR → CAPTURING auto-recovery fires
  //   without the user having to aim at the button. Browser refresh stays
  //   blocked anyway because contextIsolation strips the reload binding.
  useEffect(() => {
    const w = globalThis as unknown as {
      addEventListener: (e: string, cb: (ev: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => void) => void;
      removeEventListener: (e: string, cb: (ev: unknown) => void) => void;
    };
    const handler = (ev: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }): void => {
      if (ev.key === 'Escape') {
        if (conv.state === 'CAPTURING') conv.cancel();
        else if (conv.error) conv.dismissError();
      } else if (ev.key === ',' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        onOpenSettings();
      } else if ((ev.key === 'l' || ev.key === 'L') && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        conv.clearTranscript();
      } else if ((ev.key === 'r' || ev.key === 'R') && (ev.metaKey || ev.ctrlKey)) {
        if (conv.state !== 'ERROR') return; // let Cmd+R behave normally otherwise
        ev.preventDefault();
        conv.dismissError();
        conv.pressTalk();
        // Release after a tick so the orchestrator's auto-recovery fires
        // and the new turn starts capturing.
        (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => number }).setTimeout(
          () => conv.releaseTalk(),
          50,
        );
      }
    };
    w.addEventListener('keydown', handler as (e: unknown) => void);
    return () => w.removeEventListener('keydown', handler as (e: unknown) => void);
  }, [conv, onOpenSettings]);
  const dotClass = cn(
    'h-2.5 w-2.5 rounded-full',
    conv.connection.status === 'connected'
      ? 'bg-green-400'
      : conv.connection.status === 'connecting'
        ? 'bg-yellow-400'
        : 'bg-red-500',
  );

  return (
    <div className="flex h-full flex-col">
      {/* macOS hiddenInset traffic lights live at top-left of the window.
          The `vg-drag` region also makes the header act as a window drag handle. */}
      <header
        className="vg-drag flex items-center justify-between gap-2 pr-3 pl-[88px] pt-4 pb-2 [&_button]:vg-no-drag"
      >
        <Logo size={28} wordmark />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={conv.outputMuted ? 'Voz mutada — clica para activar' : 'Mutar voz da Hermes'}
            title={conv.outputMuted ? 'Voz mutada' : 'Mutar voz'}
            onClick={() => conv.setOutputMuted(!conv.outputMuted)}
            data-testid="mute-toggle"
            data-muted={conv.outputMuted ? 'true' : 'false'}
            className="vg-no-drag"
          >
            {conv.outputMuted ? (
              <VolumeOffIcon className="h-4 w-4 text-red-400" />
            ) : (
              <VolumeOnIcon className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Definições"
            onClick={onOpenSettings}
            data-testid="open-settings"
            className="vg-no-drag"
          >
            <SettingsIcon className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <ConnectionIndicator
        connection={conv.connection}
        bridgeUrl={bridgeUrl}
        sttStatus={conv.sttStatus}
        ttsStatus={conv.ttsStatus}
        dotClass={dotClass}
      />

      <main
        className="flex flex-1 flex-col items-center justify-center gap-8 px-6"
        data-just-woke={justWoke ? 'true' : 'false'}
      >
        <StateOrb state={conv.state} level={conv.level} />
        <CallButtonRow
          state={conv.state}
          connectionStatus={conv.connection.status}
          sttState={conv.sttStatus.state}
          ttsState={conv.ttsStatus.state}
          onPress={conv.pressTalk}
          onRelease={conv.releaseTalk}
          onCancel={conv.cancel}
        />
        <HotkeyHint
          activationMode={activationMode}
          hotkey={globalHotkey}
          wakePhrase={settings?.activation.wakePhrase ?? 'hey hermes'}
          wakeMode={settings?.activation.wakeMode ?? 'openww'}
          wakeWord={settings?.activation.wakeWord ?? 'hey_jarvis'}
        />
        <TranscriptView
          lines={conv.transcript.slice(-10)}
          totalTurns={conv.transcript.length}
          activationMode={activationMode}
          onClear={conv.transcript.length > 0 ? conv.clearTranscript : undefined}
          onCopy={
            conv.transcript.length > 0
              ? () => {
                  const formatted = conv.transcript
                    .map((l) => `${l.role === 'user' ? 'Tu' : 'Hermes'}: ${l.text}`)
                    .join('\n');
                  void navigator.clipboard.writeText(formatted);
                }
              : undefined
          }
        />
        <SttStatusBanner status={conv.sttStatus} />
        {conv.warning && (
          <div data-testid="warning-toast">
            <CommandHint message={conv.warning} variant="warning" />
          </div>
        )}
        {conv.error && (
          <div className="flex max-w-md flex-col gap-2" data-testid="error-toast">
            <CommandHint message={conv.error} variant="error" />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                data-testid="error-copy-diagnostic"
                onClick={() => {
                  // Small structured diagnostic for bug reports / support.
                  const diagnostic = [
                    `voice-gateway error @ ${new Date().toISOString()}`,
                    `bridge: ${bridgeUrl ?? '(none)'}`,
                    `state: ${conv.state}`,
                    `message: ${conv.error}`,
                  ].join('\n');
                  void navigator.clipboard.writeText(diagnostic);
                }}
              >
                Copiar diagnóstico
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/**
 * Call button + transient cancel "X" button. Splits responsibilities so the
 * main JSX block stays readable AND the disabled-tooltip + cancel-button
 * surface have a clear unit-of-testing.
 */
function CallButtonRow({
  state,
  connectionStatus,
  sttState,
  ttsState,
  onPress,
  onRelease,
  onCancel,
}: {
  state: string;
  connectionStatus: string;
  sttState: string;
  ttsState: string;
  onPress: () => void;
  onRelease: () => void;
  onCancel: () => void;
}): JSX.Element {
  const reason = disabledReason(connectionStatus, sttState, ttsState, state);
  const disabled = reason !== null;
  return (
    <div className="flex items-center gap-3">
      <div
        className="relative"
        title={reason ?? undefined}
        data-testid="call-button-wrapper"
        data-disabled-reason={reason ?? ''}
      >
        <CallButton
          state={state as Parameters<typeof CallButton>[0]['state']}
          onPress={onPress}
          onRelease={onRelease}
          disabled={disabled}
        />
        {reason && (
          // Visually hidden text for screen readers / quick inspection,
          // plus a tooltip via the parent's title.
          <span className="sr-only" data-testid="call-button-disabled-reason">
            {reason}
          </span>
        )}
      </div>
      {state === 'CAPTURING' && (
        <button
          type="button"
          aria-label="Cancelar gravação"
          data-testid="cancel-capture"
          onClick={onCancel}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-red-700/70 text-white shadow transition hover:bg-red-600"
        >
          <XIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Small hint under the call button explaining the trigger affordances —
 * adapts to PUSH_TO_TALK vs WAKE_WORD modes. Hidden in ERROR state to keep
 * the troubleshooting toast the focus.
 */
function HotkeyHint({
  activationMode,
  hotkey,
  wakePhrase,
  wakeMode,
  wakeWord,
}: {
  activationMode: 'PUSH_TO_TALK' | 'WAKE_WORD';
  hotkey: string;
  wakePhrase: string;
  wakeMode: 'openww' | 'phrase';
  wakeWord: string;
}): JSX.Element {
  const prettyHotkey = hotkey
    .replace(/CommandOrControl/, '⌘')
    .replace(/Cmd/, '⌘')
    .replace(/Ctrl/, '⌃')
    .replace(/Shift/, '⇧')
    .replace(/Alt|Option/, '⌥')
    .replace(/\+/g, '');
  const wakeLabel =
    activationMode === 'WAKE_WORD'
      ? wakeMode === 'phrase'
        ? `ou diz «${wakePhrase}»`
        : `ou diz «${wakeWord.replace(/_/g, ' ')}»`
      : `ou usa ${prettyHotkey}`;
  return (
    <p
      data-testid="hotkey-hint"
      className="text-center text-[11px] text-zinc-500"
    >
      Carrega no botão {wakeLabel}.
    </p>
  );
}

/**
 * Compact "STT preparing / TTS ready" pill rendered next to the connection
 * indicator so the user understands *why* the call button is disabled
 * before STT/TTS adapters are wired up (esp. on first launch when Piper's
 * venv auto-install is running). Goes away once both reach 'ready'.
 */
function ReadinessPill({
  sttStatus,
  ttsStatus,
}: {
  sttStatus: SttStatus;
  ttsStatus: TtsStatus;
}): JSX.Element | null {
  const stt = pillStateFor(sttStatus);
  const tts = pillStateFor(ttsStatus);
  // Don't crowd the header once everything is ready or idle (idle ≈ not
  // yet checked, which happens during the first few ms after the window
  // mounts and is uninteresting).
  if (stt === 'ok' && tts === 'ok') return null;
  if (stt === 'silent' && tts === 'silent') return null;
  return (
    <span
      data-testid="readiness-pill"
      data-stt={sttStatus.state}
      data-tts={ttsStatus.state}
      className={cn(
        'truncate rounded-full px-2 py-0.5 text-[10px]',
        stt === 'error' || tts === 'error'
          ? 'bg-red-900/50 text-red-200'
          : stt === 'busy' || tts === 'busy'
            ? 'bg-yellow-900/50 text-yellow-200'
            : 'bg-zinc-800 text-zinc-300',
      )}
    >
      {labelFor('STT', sttStatus)}
      {' • '}
      {labelFor('Voz', ttsStatus)}
    </span>
  );
}

function pillStateFor(s: SttStatus | TtsStatus): 'ok' | 'busy' | 'error' | 'silent' {
  switch (s.state) {
    case 'ready':
      return 'ok';
    case 'preparing':
      return 'busy';
    case 'error':
      return 'error';
    default:
      return 'silent';
  }
}

function labelFor(prefix: 'STT' | 'Voz', s: SttStatus | TtsStatus): string {
  switch (s.state) {
    case 'ready':
      return `${prefix}: pronto`;
    case 'preparing':
      return `${prefix}: a preparar`;
    case 'error':
      return `${prefix}: erro`;
    default:
      return `${prefix}: —`;
  }
}

/**
 * Connection status row — also doubles as a "reconnect now" button when the
 * client isn't connected. Clicking while connected is a no-op (cheap, since
 * main's reconnectNow() bails early). The role + cursor switch only kick in
 * while disconnected/connecting to keep the resting UI calm.
 */
function ConnectionIndicator({
  connection,
  bridgeUrl,
  sttStatus,
  ttsStatus,
  dotClass,
}: {
  connection: { status: string; latencyMs: number | null; reconnectAttempt: number };
  bridgeUrl: string | null;
  sttStatus: SttStatus;
  ttsStatus: TtsStatus;
  dotClass: string;
}): JSX.Element {
  const offline = connection.status !== 'connected';
  return (
    <button
      type="button"
      onClick={() => {
        if (offline) window.vg.conversation.reconnectNow();
      }}
      disabled={!offline}
      data-testid="connection-indicator"
      data-status={connection.status}
      data-clickable={offline ? 'true' : 'false'}
      title={offline ? 'Clica para tentar ligar novamente' : 'Ligação activa'}
      className={cn(
        'flex w-full items-center gap-2 px-5 pb-3 text-left text-xs text-zinc-400',
        offline
          ? 'cursor-pointer hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent'
          : 'cursor-default',
      )}
    >
      <span className={dotClass} aria-hidden="true" />
      <span>
        {connection.status === 'connected'
          ? `Ligado ${connection.latencyMs != null ? `(${connection.latencyMs} ms)` : ''}`
          : connection.status === 'connecting'
            ? connection.reconnectAttempt > 0
              ? `A ligar… (tentativa ${connection.reconnectAttempt})`
              : 'A ligar…'
            : connection.reconnectAttempt > 0
              ? `Sem ligação (tentativa ${connection.reconnectAttempt}) — clica para tentar`
              : 'Sem ligação — clica para tentar ligar'}
      </span>
      {bridgeUrl && <span className="truncate text-zinc-600">• {bridgeUrl}</span>}
      <ReadinessPill sttStatus={sttStatus} ttsStatus={ttsStatus} />
    </button>
  );
}

function SttStatusBanner({ status }: { status: SttStatus }): JSX.Element | null {
  if (status.state === 'ready' || status.state === 'idle') return null;

  if (status.state === 'preparing') {
    const p = status.progress;
    const pct = p?.fraction != null ? Math.round(p.fraction * 100) : null;
    const label =
      p?.stage === 'installing'
        ? p.detail ?? 'a instalar dependências'
        : p?.stage === 'downloading'
          ? `a descarregar modelo de voz ${p.detail ?? ''}`
          : 'a preparar reconhecimento de voz';
    return (
      <div
        role="status"
        className="flex max-w-md flex-col gap-2 rounded-xl border border-bg-subtle bg-bg-panel/60 px-4 py-3 text-xs text-zinc-300"
        data-testid="stt-status"
      >
        <div className="flex items-center justify-between gap-3">
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

  return (
    <div data-testid="stt-error" className="w-full max-w-md">
      <CommandHint message={status.message} variant="error" />
    </div>
  );
}
