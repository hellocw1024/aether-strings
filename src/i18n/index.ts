import { AR } from './locale-ar';
import { EN, JA, KO, ZH } from './locales-asia';
import { DE, ES, FR, IT, RU } from './locales-euro';
import type { LocaleId, TranslationDict, TranslationKey } from './types';

export type { LocaleId, TranslationDict, TranslationKey };

export const SUPPORTED_LOCALES: { id: LocaleId; code: string; nativeName: string; rtl?: boolean }[] = [
  { id: 'zh', code: 'ZH', nativeName: '中文' },
  { id: 'en', code: 'EN', nativeName: 'English' },
  { id: 'ja', code: 'JA', nativeName: '日本語' },
  { id: 'ko', code: 'KO', nativeName: '한국어' },
  { id: 'fr', code: 'FR', nativeName: 'Français' },
  { id: 'de', code: 'DE', nativeName: 'Deutsch' },
  { id: 'it', code: 'IT', nativeName: 'Italiano' },
  { id: 'es', code: 'ES', nativeName: 'Español' },
  { id: 'ru', code: 'RU', nativeName: 'Русский' },
  { id: 'ar', code: 'AR', nativeName: 'العربية', rtl: true },
];

export const TRANSLATIONS: Record<LocaleId, TranslationDict> = {
  zh: ZH,
  en: EN,
  ja: JA,
  ko: KO,
  fr: FR,
  de: DE,
  it: IT,
  es: ES,
  ru: RU,
  ar: AR,
};

export function isRtlLocale(locale: LocaleId): boolean {
  return locale === 'ar';
}

const STORAGE_KEY = 'aether-strings-locale';
const SUPPORTED_SET = new Set<string>(SUPPORTED_LOCALES.map((l) => l.id));

/**
 * Matches a list of browser BCP-47 language tags (e.g. ['zh-CN', 'en-US'])
 * against our 9 supported locales in priority order; falls back to 'en'.
 */
export function detectBrowserLocale(languages?: readonly string[]): LocaleId {
  const candidates: string[] = [];
  if (languages !== undefined) {
    candidates.push(...languages);
  } else if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
      candidates.push(...navigator.languages);
    }
    if (navigator.language) {
      candidates.push(navigator.language);
    }
  }

  for (const tag of candidates) {
    if (!tag) continue;
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (SUPPORTED_SET.has(primary)) {
      return primary as LocaleId;
    }
  }
  return 'en';
}

export function getSavedLocalePreference(): LocaleId | 'auto' {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED_SET.has(saved)) {
      return saved as LocaleId;
    }
  } catch {
    // ignore storage restriction
  }
  return 'auto';
}

export function resolveInitialLocale(): { locale: LocaleId; preference: LocaleId | 'auto' } {
  const pref = getSavedLocalePreference();
  return {
    locale: pref === 'auto' ? detectBrowserLocale() : pref,
    preference: pref,
  };
}

export function saveLocalePreference(pref: LocaleId | 'auto'): void {
  try {
    if (pref === 'auto') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, pref);
    }
  } catch {
    // ignore storage restriction
  }
}

export function getLocaleNativeName(locale: LocaleId): string {
  return SUPPORTED_LOCALES.find((l) => l.id === locale)?.nativeName ?? locale;
}

export function getLocaleCode(locale: LocaleId): string {
  return SUPPORTED_LOCALES.find((l) => l.id === locale)?.code ?? locale.toUpperCase();
}

export function t(
  locale: LocaleId,
  key: TranslationKey,
  vars?: Record<string, string | number>
): string {
  const dict = TRANSLATIONS[locale] ?? TRANSLATIONS.en;
  let str = dict[key] ?? TRANSLATIONS.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
  }
  return str;
}
