import { useCallback, useEffect, useRef, useState } from 'react';
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

/** Mic permission states surfaced by the main process. 'unknown' is
 *  the state right after mount before the first `getMicStatus()` IPC
 *  round-trip resolves; we treat it as a wait, not a block. */
type MicPermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/** Why the call button is disabled — surfaced as a tooltip + sr-only text. */
function disabledReason(
  connectionStatus: string,
  sttState: string,
  ttsState: string,
  state: string,
  micPermission: MicPermissionState,
): string | null {
  if (state === 'ERROR') return null; // explicitly clickable for auto-recovery
  // Mic permission is the very first thing the app needs — surface it
  // before anything else so the user knows what to fix. (I1 round 12.)
  if (micPermission === 'denied') return 'Sem permissão para o microfone — vai a Definições do sistema';
  if (micPermission === 'restricted') return 'Microfone restrito por política do sistema';
  if (micPermission === 'not-determined') return 'A pedir permissão do microfone…';
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

  // Mic permission gate (I1 round 12). The call button stays inert and
  // the user gets a clear prompt until macOS reports 'granted'. We poll
  // the status on mount + every time the window regains focus (the user
  // may have just toggled the permission in System Preferences and come
  // back), capped to 1s intervals so we don't hammer the IPC.
  const [micPermission, setMicPermission] = useState<MicPermissionState>('unknown');
  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const s = await window.vg.audio.getMicStatus();
        if (!cancelled) setMicPermission(s as MicPermissionState);
      } catch {
        // Best-effort — never block the renderer on a permission probe.
      }
    };
    void check();
    const w = globalThis as unknown as {
      addEventListener: (e: string, cb: () => void) => void;
      removeEventListener: (e: string, cb: () => void) => void;
    };
    const onFocus = (): void => void check();
    w.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      w.removeEventListener('focus', onFocus);
    };
  }, []);
  const requestMic = useCallback(async () => {
    try {
      await window.vg.audio.requestMic();
    } finally {
      // Re-probe regardless of result so the UI reflects whatever the
      // OS landed on (granted, denied, still not-determined on rare
      // races).
      try {
        const s = await window.vg.audio.getMicStatus();
        setMicPermission(s as MicPermissionState);
      } catch {
        // ignore
      }
    }
  }, []);
  const openMicSettings = useCallback(async () => {
    try {
      await window.vg.audio.openMicSettings();
    } catch {
      // ignore
    }
  }, []);

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

  // System-notification trigger: when a NEW assistant turn lands AND the
  // window is hidden or unfocused, fire a Notification so the user
  // knows there's a reply waiting. Skipped if TTS is muted (the user
  // has signalled they don't want audible nudges right now) or if
  // Notifications haven't been granted.
  //
  // We use the assistant transcript line id as the edge marker rather
  // than the SPEAKING state, because text-only replies (no Piper audio)
  // skip SPEAKING entirely. Tracking the id also dedups so the same
  // reply never fires twice across re-renders.
  const lastNotifiedTurnRef = useRef<string | null>(null);
  useEffect(() => {
    const lastAssistant = [...conv.transcript].reverse().find((l) => l.role === 'assistant');
    if (!lastAssistant) return;
    if (lastAssistant.id === lastNotifiedTurnRef.current) return;
    // Only fire once we're back at rest (don't ping during STREAMING).
    if (conv.state !== 'IDLE' && conv.state !== 'LISTENING_WAKE') return;
    lastNotifiedTurnRef.current = lastAssistant.id;
    if (conv.outputMuted) return;
    const doc = (globalThis as unknown as { document?: { hidden: boolean; hasFocus: () => boolean } }).document;
    if (!doc) return;
    if (!doc.hidden && doc.hasFocus()) return;
    try {
      const NotificationCtor = (globalThis as unknown as { Notification?: typeof Notification }).Notification;
      if (!NotificationCtor) return;
      if (NotificationCtor.permission === 'granted') {
        new NotificationCtor('Hermes respondeu', {
          body: lastAssistant.text.slice(0, 140),
          silent: true,
          tag: 'vg-reply',
        });
      } else if (NotificationCtor.permission !== 'denied') {
        // Best-effort one-shot: request once. Don't await — next reply
        // will be fast-pathed once the user picks "Allow".
        void NotificationCtor.requestPermission();
      }
    } catch {
      // Notifications unavailable in this runtime (e.g. headless E2E
      // without --enable-features). Silent fallback is fine.
    }
  }, [conv.state, conv.outputMuted, conv.transcript]);

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
      } else if ((ev.key === 's' || ev.key === 'S') && (ev.metaKey || ev.ctrlKey)) {
        if (conv.transcript.length === 0) return; // nothing to save
        ev.preventDefault();
        const formatted = conv.transcript
          .map((l) => `${l.role === 'user' ? 'Tu' : 'Hermes'}: ${l.text}`)
          .join('\n');
        void window.vg.transcript.export({
          text: formatted,
          defaultFileName: `voice-gateway-${new Date().toISOString().slice(0, 10)}.txt`,
        });
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
        <MicPermissionBanner
          permission={micPermission}
          onRequest={requestMic}
          onOpenSettings={openMicSettings}
        />
        <CallButtonRow
          state={conv.state}
          connectionStatus={conv.connection.status}
          sttState={conv.sttStatus.state}
          ttsState={conv.ttsStatus.state}
          micPermission={micPermission}
          onPress={conv.pressTalk}
          onRelease={conv.releaseTalk}
          onCancel={conv.cancel}
        />
        <CaptureElapsed capturing={conv.state === 'CAPTURING'} />
        <MainVuMeter capturing={conv.state === 'CAPTURING'} level={conv.level} />
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
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                data-testid="error-retry"
                onClick={() => {
                  // Same as Cmd+R but discoverable from the toast.
                  conv.dismissError();
                  conv.pressTalk();
                  (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => number }).setTimeout(
                    () => conv.releaseTalk(),
                    50,
                  );
                }}
              >
                Tentar de novo
              </Button>
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
  micPermission,
  onPress,
  onRelease,
  onCancel,
}: {
  state: string;
  connectionStatus: string;
  sttState: string;
  ttsState: string;
  micPermission: MicPermissionState;
  onPress: () => void;
  onRelease: () => void;
  onCancel: () => void;
}): JSX.Element {
  const reason = disabledReason(connectionStatus, sttState, ttsState, state, micPermission);
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
 * Hero banner shown when the OS hasn't granted mic access yet. Replaces
 * the call button area entirely until permission lands so the user has
 * a clear next-action. (I1 round 12.)
 */
function MicPermissionBanner({
  permission,
  onRequest,
  onOpenSettings,
}: {
  permission: MicPermissionState;
  onRequest: () => void;
  onOpenSettings: () => void;
}): JSX.Element | null {
  if (permission === 'granted' || permission === 'unknown') return null;
  const isDenied = permission === 'denied' || permission === 'restricted';
  return (
    <div
      data-testid="mic-permission-banner"
      data-permission={permission}
      className="flex max-w-md flex-col items-center gap-3 rounded-2xl border border-amber-700 bg-amber-950/40 px-5 py-4 text-center text-sm text-amber-100"
      role="status"
    >
      <p className="font-medium">
        {isDenied
          ? 'O Voice Gateway precisa de permissão para usar o microfone.'
          : 'Permissão do microfone ainda não confirmada.'}
      </p>
      <p className="text-xs text-amber-200/80">
        {isDenied
          ? 'Abre as Definições do sistema para autorizar o microfone — o botão de chamada só fica activo depois.'
          : 'Carrega em Pedir permissão. Se o macOS já tiver respondido, a permissão aparece quando voltares à janela.'}
      </p>
      <div className="flex gap-2">
        {!isDenied && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="mic-permission-request"
            onClick={onRequest}
          >
            Pedir permissão
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="mic-permission-open-settings"
          onClick={onOpenSettings}
        >
          Abrir Definições do sistema
        </Button>
      </div>
    </div>
  );
}

/**
 * Mini "elapsed" counter that ticks while the user is holding PTT (or the
 * wake-word capture window is open). Helps the user gauge whether they
 * went over the soft 30 s STT timeout without staring at a stopwatch.
 *
 * The interval is on a 100 ms cadence so the displayed tenths-of-a-second
 * actually move. We restart from 0 on every CAPTURING entry — long-term
 * `Date.now()` math avoids drift if the JS event loop pauses for a beat.
 */
function CaptureElapsed({ capturing }: { capturing: boolean }): JSX.Element | null {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!capturing) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const handle = (globalThis as unknown as {
      setInterval: (cb: () => void, ms: number) => number;
    }).setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => {
      (globalThis as unknown as { clearInterval: (h: number) => void }).clearInterval(handle);
    };
  }, [capturing]);
  if (!capturing) return null;
  const seconds = (elapsedMs / 1000).toFixed(1);
  return (
    <p
      data-testid="capture-elapsed"
      data-ms={String(elapsedMs)}
      className="font-mono text-[11px] tabular-nums text-zinc-400"
      aria-label={`Tempo de gravação: ${seconds} segundos`}
    >
      {seconds}s
    </p>
  );
}

/**
 * Slim VU meter that only appears while we're CAPTURING. Echoes the same
 * `conv.level` value the settings panel uses, so users see "yes the mic
 * is picking up sound" without having to open Settings. Width animates
 * 0..100 % so it's visible even at low levels (Math.max with a 4 % floor).
 */
function MainVuMeter({
  capturing,
  level,
}: {
  capturing: boolean;
  level: number;
}): JSX.Element | null {
  if (!capturing) return null;
  const pct = Math.round(Math.max(0.04, Math.min(1, level)) * 100);
  return (
    <div
      data-testid="main-vu-meter"
      data-level={level.toFixed(3)}
      className="h-1 w-32 overflow-hidden rounded-full bg-bg-subtle"
      aria-label="Nível do microfone"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-75"
        style={{ width: `${pct}%` }}
      />
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
