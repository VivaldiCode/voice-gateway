import { useEffect, useState } from 'react';
import { PairingWizard } from './components/PairingWizard';
import { useAppStore } from './store/app-store';
import { useSettingsBootstrap } from './hooks/useSettings';

export default function App(): JSX.Element {
  useSettingsBootstrap();
  const settings = useAppStore((s) => s.settings);
  const [wizardActive, setWizardActive] = useState<boolean | null>(null);

  useEffect(() => {
    // Decide once on first load whether to enter the wizard. After that, the
    // wizard owns its lifecycle: it stays mounted until the user explicitly
    // clicks "Abrir Voice Gateway" (which calls onComplete).
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
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-3xl font-semibold">Voice Gateway</h1>
      <p className="text-sm text-zinc-400" data-testid="main-ready">
        Ligado a <code>{settings.pairing?.url ?? '—'}</code>
      </p>
      <p className="text-xs text-zinc-500">UI de conversa em construção.</p>
    </div>
  );
}
