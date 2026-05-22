import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Renders a friendly error / hint message. Anything between backticks is
 * extracted as a copy-able `<code>` block (selectable, with a copy button)
 * so users can paste commands straight into their terminal.
 *
 * Example input:
 *   "Whisper local não está instalado. No terminal: `brew install whisper-cpp`."
 * Renders the text, then a code block "brew install whisper-cpp" with a
 * one-click copy button.
 */
export interface CommandHintProps {
  message: string;
  variant?: 'error' | 'warning' | 'info';
}

export function CommandHint({ message, variant = 'error' }: CommandHintProps): JSX.Element {
  const segments = splitBackticks(message);
  const text = segments
    .filter((s) => s.type === 'text')
    .map((s) => s.value)
    .join('');
  const commands = segments
    .filter((s) => s.type === 'code')
    .map((s) => s.value);

  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex max-w-md flex-col gap-2 rounded-xl border px-4 py-3 text-sm',
        variant === 'error' && 'border-red-800 bg-red-950/40 text-red-200',
        variant === 'warning' && 'border-yellow-800 bg-yellow-950/40 text-yellow-200',
        variant === 'info' && 'border-bg-subtle bg-bg-panel/60 text-zinc-200',
      )}
    >
      <p className="select-text whitespace-pre-wrap">
        {segments.map((s, i) =>
          s.type === 'text' ? (
            <span key={i}>{s.value}</span>
          ) : (
            <code
              key={i}
              className="select-text rounded bg-black/40 px-1.5 py-0.5 font-mono text-[12px] text-white"
            >
              {s.value}
            </code>
          ),
        )}
      </p>
      {commands.map((cmd, idx) => (
        <CopyableCommand key={`${idx}-${cmd}`} command={cmd} />
      ))}
      {/* For accessibility: keep the full original message text for screen
          readers, in case the segmented render confuses assistive tech. */}
      <span className="sr-only">{text}</span>
    </div>
  );
}

function CopyableCommand({ command }: { command: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Best-effort; clipboard API can fail in some sandbox configs.
    }
  }, [command]);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-bg-subtle bg-black/40 px-3 py-2">
      <code className="flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-[12px] text-white">
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copiado' : 'Copiar comando'}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded transition',
          copied ? 'bg-green-700/60 text-green-100' : 'bg-bg-panel text-zinc-300 hover:bg-bg-subtle',
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

type Segment = { type: 'text'; value: string } | { type: 'code'; value: string };

function splitBackticks(input: string): Segment[] {
  const out: Segment[] = [];
  let buf = '';
  let inCode = false;
  for (const ch of input) {
    if (ch === '`') {
      if (buf) out.push({ type: inCode ? 'code' : 'text', value: buf });
      buf = '';
      inCode = !inCode;
      continue;
    }
    buf += ch;
  }
  if (buf) out.push({ type: inCode ? 'code' : 'text', value: buf });
  return out;
}
