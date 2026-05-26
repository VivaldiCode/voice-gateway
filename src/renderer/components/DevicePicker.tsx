import { useCallback, useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../lib/cn';

/**
 * Minimalist popover-style picker for an input/output audio device.
 * Round-13 issue #20: lets the user switch mic or speaker without
 * leaving the main window. Settings panel still has the canonical
 * picker; this one is a header-level shortcut for the common case
 * (just plugged in headphones, want to swap right now).
 *
 * Renders as a small ghost icon button. Clicking opens a popover
 * listing every enumerated device of the matching `kind`. The
 * currently active device gets a check mark. Selecting a device
 * calls `onSelect(deviceId)` — the parent persists via
 * `window.vg.settings.set` so the orchestrator's reconciliation
 * picks it up live.
 *
 * Device labels need mic permission to populate. When labels come
 * back empty (no permission yet) we surface a hint instead of an
 * unhelpful "(unnamed device)" list — clicking still records the
 * deviceId, just the human label is missing.
 *
 * Close behaviours:
 *   - Click outside → close
 *   - Escape → close
 *   - devicechange event → re-enumerate (catches hot-plug)
 *
 * Re-enumeration only fires while the popover is open; idle pickers
 * don't keep the mediaDevices subscription alive.
 */

export interface DevicePickerProps {
  /** 'audioinput' for mic, 'audiooutput' for speaker. */
  kind: 'audioinput' | 'audiooutput';
  /** Lucide icon to render in the trigger button. */
  Icon: LucideIcon;
  /** aria-label / tooltip text for the trigger. Should be localised. */
  ariaLabel: string;
  /** Heading shown at the top of the open popover. Localised. */
  popoverTitle: string;
  /** Hint shown when device labels aren't populated yet (no mic perm). */
  noLabelsHint: string;
  /** Label for the "use system default" pseudo-entry. Localised. */
  defaultLabel: string;
  /** Currently-selected device id from settings.audio.{input,output}DeviceId. */
  selectedId: string | null;
  /** Called when the user picks a device (or `null` for system default). */
  onSelect: (deviceId: string | null) => void;
  /** Test ID prefix; the trigger gets `${testId}-trigger`, the popover
   *  `${testId}-popover`, each option `${testId}-option-{deviceId}`. */
  testId: string;
}

interface DeviceInfo {
  deviceId: string;
  label: string;
}

export function DevicePicker({
  kind,
  Icon,
  ariaLabel,
  popoverTitle,
  noLabelsHint,
  defaultLabel,
  selectedId,
  onSelect,
  testId,
}: DevicePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const enumerate = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const matching = all
        .filter((d) => d.kind === kind)
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
      setDevices(matching);
    } catch {
      // mediaDevices might not be available (e.g. some test contexts).
      // Surface as an empty list so the popover at least renders the
      // "no devices" hint instead of crashing.
      setDevices([]);
    }
  }, [kind]);

  // Re-enumerate every time the popover opens AND when devices change
  // while it's open. The devicechange listener is cheap (a single
  // boolean check inside the callback) so this is fine to wire up
  // conditionally.
  useEffect(() => {
    if (!open) return;
    void enumerate();
    const handler = (): void => void enumerate();
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler);
    };
  }, [open, enumerate]);

  // Click-outside + Escape close. Capture phase so we beat any
  // bubbling-phase handler the rest of the page might have for
  // Escape (e.g. cancel-capture).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Node | null;
      if (!target || !wrapperRef.current) return;
      if (!wrapperRef.current.contains(target)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Tiny "·" dot on the icon when a non-default device is active —
  // gives the user a passive at-a-glance signal without opening
  // anything.
  const hasOverride = selectedId !== null && selectedId !== 'default';

  // Build the full options list: a synthetic "default" entry first,
  // then every enumerated device. The default entry maps to `null`
  // (matches the schema default in settings.audio).
  const allMissingLabels =
    devices.length > 0 && devices.every((d) => d.label.length === 0);

  return (
    <div ref={wrapperRef} className="relative" data-testid={testId}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        data-testid={`${testId}-trigger`}
        data-open={open ? 'true' : 'false'}
        data-has-override={hasOverride ? 'true' : 'false'}
        className="vg-no-drag relative"
      >
        <Icon className="h-4 w-4" />
        {hasOverride && (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent"
          />
        )}
      </Button>
      {open && (
        <div
          role="listbox"
          aria-label={popoverTitle}
          data-testid={`${testId}-popover`}
          className="absolute right-0 top-full z-40 mt-1 flex w-56 flex-col gap-1 rounded-xl border border-bg-subtle bg-bg-panel p-1 text-xs shadow-2xl"
        >
          <p className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">
            {popoverTitle}
          </p>
          <DeviceOption
            label={defaultLabel}
            active={selectedId === null}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            testId={`${testId}-option-default`}
          />
          {allMissingLabels && (
            <p
              className="px-2 py-1 text-[11px] italic text-amber-300"
              data-testid={`${testId}-no-labels-hint`}
            >
              {noLabelsHint}
            </p>
          )}
          {devices.map((d, idx) => (
            <DeviceOption
              key={`${d.deviceId}-${idx}`}
              label={d.label || `${kind === 'audioinput' ? 'mic' : 'speaker'} #${idx + 1}`}
              active={selectedId === d.deviceId}
              onClick={() => {
                onSelect(d.deviceId);
                setOpen(false);
              }}
              testId={`${testId}-option-${d.deviceId || idx}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DeviceOption({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition',
        active ? 'bg-bg-subtle text-white' : 'text-zinc-300 hover:bg-bg-subtle/60 hover:text-white',
      )}
    >
      <span className="truncate">{label}</span>
      {active && <Check className="h-3 w-3 text-accent" aria-hidden="true" />}
    </button>
  );
}
