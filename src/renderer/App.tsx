import { useEffect, useRef, useState } from 'react';
import type { PairingInfo } from '../shared/types';
import { PairingWizard } from './components/PairingWizard';
import { MainScreen } from './components/MainScreen';
import { SettingsPanel } from './components/SettingsPanel';
import { useAppStore } from './store/app-store';
import { useSettingsBootstrap } from './hooks/useSettings';

function detectView(): 'settings' | 'main' {
  try {
    const v = new URL(window.location.href).searchParams.get('view');
    return v === 'settings' ? 'settings' : 'main';
  } catch {
    return 'main';
  }
}

export default function App(): JSX.Element {
  useSettingsBootstrap();
  const settings = useAppStore((s) => s.settings);
  const view = detectView();
  const [wizardActive, setWizardActive] = useState<boolean | null>(null);

  // Tracks the last pairing value the renderer observed. We use this to
  // distinguish "first settings load" from "user explicitly cleared the
  // pairing via Re-emparelhar" — the two need different wizardActive
  // transitions (initial: open wizard if missing; clear: open wizard; set:
  // do NOT auto-close, let the wizard's own onComplete handle that so the
  // "done" step stays mounted long enough for the user to see it).
  const prevPairingRef = useRef<PairingInfo | null | undefined>(undefined);

  useEffect(() => {
    if (view === 'settings') {
      setWizardActive(false);
      return;
    }
    if (!settings) return;
    const prev = prevPairingRef.current;
    const cur = settings.pairing;
    if (prev === undefined) {
      // First settings load — initial wizard visibility.
      setWizardActive(!cur);
    } else if (prev && !cur) {
      // Pairing was previously set, now cleared (Re-emparelhar) — re-open
      // the wizard.
      setWizardActive(true);
    }
    // pairing transitions from null → set: leave wizardActive alone so the
    // wizard's "done" step can render until the user clicks "Open" and
    // onComplete fires.
    prevPairingRef.current = cur;
  }, [settings, view]);

  if (!settings || wizardActive === null) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-zinc-500"
        data-testid="loading"
      >
        a iniciar…
      </div>
    );
  }

  // Dedicated settings window — full viewport, no main UI behind it.
  if (view === 'settings') {
    return (
      <SettingsPanel
        settings={settings}
        layout="window"
        onClose={() => window.close()}
        onRePair={async () => {
          await window.vg.settings.set({ pairing: null });
          window.close();
        }}
      />
    );
  }

  if (wizardActive) {
    return <PairingWizard onComplete={() => setWizardActive(false)} />;
  }

  return (
    <MainScreen
      bridgeUrl={settings.pairing?.url ?? null}
      onOpenSettings={() => window.vg.settings.openWindow()}
    />
  );
}
