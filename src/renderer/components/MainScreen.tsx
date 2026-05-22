import { Settings as SettingsIcon } from 'lucide-react';
import { Button } from './Button';
import { CallButton } from './CallButton';
import { Logo } from './Logo';
import { StateOrb } from './StateOrb';
import { TranscriptView } from './TranscriptView';
import { useConversation } from '../hooks/useConversation';
import { cn } from '../lib/cn';
import type { SttStatus } from '../global';

export interface MainScreenProps {
  bridgeUrl: string | null;
  onOpenSettings: () => void;
}

export function MainScreen({ bridgeUrl, onOpenSettings }: MainScreenProps): JSX.Element {
  const conv = useConversation();
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
      <header className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
        <Logo size={28} wordmark />
        <Button
          variant="ghost"
          size="sm"
          aria-label="Definições"
          onClick={onOpenSettings}
          data-testid="open-settings"
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
              ? 'A ligar…'
              : 'Sem ligação'}
        </span>
        {bridgeUrl && <span className="truncate text-zinc-600">• {bridgeUrl}</span>}
      </div>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
        <StateOrb state={conv.state} />
        <CallButton
          state={conv.state}
          onPress={conv.pressTalk}
          onRelease={conv.releaseTalk}
          disabled={
            conv.connection.status !== 'connected' || conv.sttStatus.state !== 'ready'
          }
        />
        <TranscriptView lines={conv.transcript.slice(-10)} />
        <SttStatusBanner status={conv.sttStatus} />
        {conv.error && (
          <p
            role="alert"
            className="max-w-md rounded-xl border border-red-800 bg-red-950/40 px-4 py-2 text-xs text-red-200"
          >
            {conv.error}
          </p>
        )}
      </main>
    </div>
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

  // error
  return (
    <div
      role="alert"
      className="max-w-md rounded-xl border border-red-800 bg-red-950/40 px-4 py-2 text-xs text-red-200"
      data-testid="stt-error"
    >
      {status.message}
    </div>
  );
}
