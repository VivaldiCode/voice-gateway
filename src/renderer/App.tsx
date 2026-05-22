import { useEffect, useState } from 'react';
import { PairingWizard } from './components/PairingWizard';
import { MainScreen } from './components/MainScreen';
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

  return (
    <>
      <MainScreen
        bridgeUrl={settings.pairing?.url ?? null}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && (
        <div
          className="fixed inset-0 flex items-end justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setSettingsOpen(false)}
          role="dialog"
          aria-label="Definições"
        >
          <div
            className="m-4 w-full max-w-md rounded-2xl border border-bg-subtle bg-bg-panel p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 text-lg font-semibold">Definições</h2>
            <p className="text-sm text-zinc-400">
              Painel de definições virá numa próxima fase.
            </p>
            <button
              className="mt-4 text-sm text-accent hover:underline"
              onClick={() => setSettingsOpen(false)}
            >
              fechar
            </button>
          </div>
        </div>
      )}
    </>
  );
}
