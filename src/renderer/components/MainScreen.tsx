import { useEffect } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { Button } from './Button';
import { CallButton } from './CallButton';
import { CommandHint } from './CommandHint';
import { Logo } from './Logo';
import { StateOrb } from './StateOrb';
import { TranscriptView } from './TranscriptView';
import { useConversation } from '../hooks/useConversation';
import { cn } from '../lib/cn';
import type { SttStatus, TtsStatus } from '../global';

export interface MainScreenProps {
  bridgeUrl: string | null;
  onOpenSettings: () => void;
}

export function MainScreen({ bridgeUrl, onOpenSettings }: MainScreenProps): JSX.Element {
  const conv = useConversation();

  // Window-level keyboard shortcuts.
  // - Escape: dismiss the sticky error toast, OR if we're CAPTURING, cancel
  //   the in-flight turn so the user doesn't have to find a button.
  // - Cmd+,: open the Settings window — macOS standard shortcut.
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
      </header>
      <div
        className="flex items-center gap-2 px-5 pb-3 text-xs text-zinc-400"
        data-testid="connection-indicator"
      >
        <span className={dotClass} aria-hidden="true" />
        <span>
          {conv.connection.status === 'connected'
            ? `Ligado ${conv.connection.latencyMs != null ? `(${conv.connection.latencyMs} ms)` : ''}`
            : conv.connection.status === 'connecting'
              ? conv.connection.reconnectAttempt > 0
                ? `A ligar… (tentativa ${conv.connection.reconnectAttempt})`
                : 'A ligar…'
              : conv.connection.reconnectAttempt > 0
                ? `Sem ligação (tentativa ${conv.connection.reconnectAttempt})`
                : 'Sem ligação'}
        </span>
        {bridgeUrl && <span className="truncate text-zinc-600">• {bridgeUrl}</span>}
        <ReadinessPill sttStatus={conv.sttStatus} ttsStatus={conv.ttsStatus} />
      </div>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
        <StateOrb state={conv.state} level={conv.level} />
        <CallButton
          state={conv.state}
          onPress={conv.pressTalk}
          onRelease={conv.releaseTalk}
          /* Stay clickable when state === 'ERROR' so the new FSM
             PTT-from-ERROR transition can recover automatically. */
          disabled={
            conv.connection.status !== 'connected' ||
            (conv.sttStatus.state !== 'ready' && conv.state !== 'ERROR')
          }
        />
        <TranscriptView lines={conv.transcript.slice(-10)} />
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
