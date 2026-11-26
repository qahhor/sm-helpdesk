import { afterEach, expect, test, vi } from 'vitest';
import { LOCALE_COOKIE, localeCookieName, localeFromCookies } from '@/i18n/locales';
import { THEME_COOKIE, THEME_SCRIPT, themeCookieName } from '@/ui/theme/theme';
import { chooseTheme, readTheme } from '@/ui/theme/theme-client';

// Куки выбора языка и темы (ASVS 5.0.0, требования 3.3.1 и 3.3.3; план подготовки M9, задача 1). На https имя с
// приставкой __Host-: кука только этого хоста, с Secure и Path=/, поддомен не подложит свою. На http (разработка,
// тесты) имя без приставки: браузер не примет __Host- без Secure. Так же устроены куки входа (решение 0021).

afterEach(() => vi.unstubAllGlobals());

test('имена кук на https с приставкой __Host-, на http без неё', () => {
  expect(themeCookieName(true)).toBe('__Host-hub_theme');
  expect(themeCookieName(false)).toBe(THEME_COOKIE);
  expect(localeCookieName(true)).toBe('__Host-hub_locale');
  expect(localeCookieName(false)).toBe(LOCALE_COOKIE);
});

test('язык из куки читается под обоими именами, кука с приставкой важнее', () => {
  const jar = (values: Record<string, string>) => ({ get: (name: string) => (name in values ? { value: values[name] as string } : undefined) });
  expect(localeFromCookies(jar({ '__Host-hub_locale': 'uz' }))).toBe('uz');
  expect(localeFromCookies(jar({ hub_locale: 'en' }))).toBe('en');
  expect(localeFromCookies(jar({ hub_locale: 'en', '__Host-hub_locale': 'uz' }))).toBe('uz');
  expect(localeFromCookies(jar({}))).toBeUndefined();
});

function fakeBrowser(protocol: 'http:' | 'https:', cookie = '') {
  const classes = new Set<string>();
  const document = {
    cookie,
    documentElement: { classList: { toggle: (name: string, on: boolean) => void (on ? classes.add(name) : classes.delete(name)) } },
  };
  const window = { location: { protocol }, matchMedia: () => ({ matches: false }), dispatchEvent: () => true };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  return { document, classes };
}

test('скрипт темы до отрисовки читает куку с приставкой __Host- и без неё', () => {
  for (const cookie of ['__Host-hub_theme=dark', 'hub_theme=dark', 'a=1; __Host-hub_theme=dark']) {
    const browser = fakeBrowser('https:', cookie);
    new Function(THEME_SCRIPT)();
    expect(browser.classes.has('dark'), cookie).toBe(true);
  }
  const light = fakeBrowser('https:', 'x__Host-hub_theme=dark');
  new Function(THEME_SCRIPT)();
  expect(light.classes.has('dark')).toBe(false);
});

test('выбор темы на https пишется кукой __Host- с Secure и Path=/, на http прежней кукой', () => {
  const secure = fakeBrowser('https:');
  chooseTheme('dark');
  expect(secure.document.cookie).toMatch(/^__Host-hub_theme=dark; path=\/; max-age=\d+; samesite=lax; secure$/);
  secure.document.cookie = '__Host-hub_theme=light';
  expect(readTheme()).toBe('light');
  const plain = fakeBrowser('http:');
  chooseTheme('dark');
  expect(plain.document.cookie).toMatch(/^hub_theme=dark; path=\/; max-age=\d+; samesite=lax$/);
});
