import { useEffect } from 'react';
import { useAppStore } from '../store/app-store';

export function useSettingsBootstrap(): void {
  const setSettings = useAppStore((s) => s.setSettings);

  useEffect(() => {
    void window.vg.settings.get().then((s) => setSettings(s));
    const unsub = window.vg.settings.onChange(setSettings);
    return () => unsub();
  }, [setSettings]);
}
