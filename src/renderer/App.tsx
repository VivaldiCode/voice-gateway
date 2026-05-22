import { useEffect, useState } from 'react';
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

  useEffect(() => {
    // The settings window never shows the wizard regardless of pairing.
    if (view === 'settings') {
      setWizardActive(false);
      return;
    }
    if (settings && wizardActive === null) {
      setWizardActive(!settings.pairing);
    }
  }, [settings, wizardActive, view]);

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
