import { describe, expect, it } from 'vitest';
import {
  detectBrowserLocale,
  isRtlLocale,
  SUPPORTED_LOCALES,
  t,
  TRANSLATIONS,
  type LocaleId,
  type TranslationKey,
} from '../../i18n';

describe('i18n 10-language system & browser locale detection', () => {
  it('auto-detects all 10 supported languages from realistic BCP-47 browser tags', () => {
    expect(detectBrowserLocale(['zh-CN', 'en-US'])).toBe('zh');
    expect(detectBrowserLocale(['zh-TW'])).toBe('zh');
    expect(detectBrowserLocale(['en-GB'])).toBe('en');
    expect(detectBrowserLocale(['ja-JP'])).toBe('ja');
    expect(detectBrowserLocale(['ko-KR'])).toBe('ko');
    expect(detectBrowserLocale(['fr-CA'])).toBe('fr');
    expect(detectBrowserLocale(['de-AT'])).toBe('de');
    expect(detectBrowserLocale(['it-CH'])).toBe('it');
    expect(detectBrowserLocale(['es-MX'])).toBe('es');
    expect(detectBrowserLocale(['ru-RU'])).toBe('ru');
    expect(detectBrowserLocale(['ar-SA'])).toBe('ar');
  });

  it('respects browser language preference priority and falls back to English', () => {
    expect(detectBrowserLocale(['sv-SE', 'nb-NO', 'ja-JP', 'en-US'])).toBe('ja');
    expect(detectBrowserLocale(['pt-BR', 'nl-NL'])).toBe('en');
    expect(detectBrowserLocale([])).toBe('en');
  });

  it('marks Arabic as RTL and all other 9 locales as LTR', () => {
    expect(isRtlLocale('ar')).toBe(true);
    for (const loc of SUPPORTED_LOCALES) {
      if (loc.id !== 'ar') {
        expect(isRtlLocale(loc.id)).toBe(false);
      }
    }
  });

  it('has 100% key parity, non-empty values, and matching interpolation placeholders across all 10 locales', () => {
    const baseKeys = Object.keys(TRANSLATIONS.zh).sort() as TranslationKey[];
    const extractVars = (str: string) =>
      [...str.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

    expect(SUPPORTED_LOCALES).toHaveLength(10);

    for (const { id } of SUPPORTED_LOCALES) {
      const dict = TRANSLATIONS[id as LocaleId];
      expect(Object.keys(dict).sort(), `keys match for ${id}`).toEqual(baseKeys);
      for (const key of baseKeys) {
        expect(dict[key].trim().length, `${id}.${key} non-empty`).toBeGreaterThan(0);
        expect(extractVars(dict[key]), `${id}.${key} placeholders match zh`).toEqual(
          extractVars(TRANSLATIONS.zh[key])
        );
      }
    }
  });

  it('interpolates template variables cleanly', () => {
    expect(t('en', 'toastLoopCountIn', { bars: 4 })).toContain('4');
    expect(t('ar', 'hudStringsCount', { n: 6 })).toContain('6');
    expect(t('ru', 'toastLoopBpm', { bpm: 120 })).toContain('120');
  });
});
