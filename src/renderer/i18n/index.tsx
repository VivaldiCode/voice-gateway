/**
 * Tiny i18n runtime — round-12 I2.
 *
 * We deliberately don't pull in a full library (react-intl, i18next) yet:
 *
 *   - the catalogue is small (50ish keys) so type-safe object lookup
 *     beats ICU parsing for both bundle size and ergonomics
 *   - every component already reads from a typed source so the t()
 *     helper just maps the active dictionary
 *   - the active locale lives in settings.ui.language and is mirrored
 *     into a module-level variable + a React context so non-component
 *     code (notifications, exports) can call t() too
 *
 * If the catalogue ever balloons to thousands of keys, swap the
 * dictionary for i18next without changing the public API surface.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LanguageCode } from '../../shared/constants';
import { pt, type Dictionary } from './pt';
import { en } from './en';

const dictionaries: Record<LanguageCode, Dictionary> = { pt, en };

// Module-level mirror so non-component callers (e.g. main-process-bound
// helpers in the renderer) can still resolve strings without dragging a
// React context through. The provider keeps this in sync with React state.
let activeLocale: LanguageCode = 'pt';

export function setLocale(next: LanguageCode): void {
  activeLocale = next;
}

export function getLocale(): LanguageCode {
  return activeLocale;
}

export function tFor(locale: LanguageCode): Dictionary {
  return dictionaries[locale] ?? dictionaries.pt;
}

/**
 * Imperative helper for non-component code. Prefer the `useT()` hook
 * inside components so re-renders pick up locale switches.
 */
export function t(): Dictionary {
  return tFor(activeLocale);
}

const I18nContext = createContext<{ locale: LanguageCode; dict: Dictionary }>({
  locale: 'pt',
  dict: pt,
});

export interface I18nProviderProps {
  locale: LanguageCode;
  children: ReactNode;
}

export function I18nProvider({ locale, children }: I18nProviderProps): JSX.Element {
  // Mirror into the module global so imperative t() callers see the
  // active locale.
  useEffect(() => {
    setLocale(locale);
  }, [locale]);
  const value = useMemo(() => ({ locale, dict: tFor(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): Dictionary {
  return useContext(I18nContext).dict;
}

export function useLocale(): LanguageCode {
  return useContext(I18nContext).locale;
}

/**
 * Convenience hook for components rendered ABOVE the I18nProvider — they
 * still want the active dictionary, just from the module global. Returns
 * a stable reference so changing locale doesn't re-render every caller.
 */
export function useFallbackDictionary(): Dictionary {
  const [dict, setDict] = useState<Dictionary>(() => tFor(activeLocale));
  useEffect(() => {
    // Poll the global on a low cadence so consumers that don't get the
    // provider value still see locale flips eventually. Cheap (a single
    // pointer compare) so 1 s is fine.
    const handle = window.setInterval(() => {
      const next = tFor(activeLocale);
      setDict((prev) => (prev === next ? prev : next));
    }, 1_000);
    return () => window.clearInterval(handle);
  }, []);
  return dict;
}
