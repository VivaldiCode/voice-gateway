import { useEffect, useState } from 'react';
import { PairingWizard } from './components/PairingWizard';
import { MainScreen } from './components/MainScreen';
import { SettingsPanel } from './components/SettingsPanel';
import { useAppStore } from './store/app-store';
import { useSettingsBootstrap } from './hooks/useSettings';

export default function App(): JSX.Element {
  useSettingsBootstrap();
  const settings = useAppStore((s) => s.settings);
  const [wizardActive, setWizardActive] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (settings && wizardActive === null) {
      setWizardActive(!settings.pairing);
    }
  }, [settings, wizardActive]);

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

  if (wizardActive) {
    return <PairingWizard onComplete={() => setWizardActive(false)} />;
  }

  const handleRePair = async (): Promise<void> => {
    await window.vg.settings.set({ pairing: null });
    setSettingsOpen(false);
    setWizardActive(true);
  };

  return (
    <>
      <MainScreen
        bridgeUrl={settings.pairing?.url ?? null}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onRePair={() => void handleRePair()}
        />
      )}
    </>
  );
}
