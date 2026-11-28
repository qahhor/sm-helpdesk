import { expect, test } from 'vitest';
import { localizedPath, resolveLocale } from '@/i18n/resolve-locale';

test('порядок: настройка пользователя, язык Smartup, язык браузера, русский (FR-I18N-06)', () => {
  expect(resolveLocale({ userPref: 'en', smartupLocale: 'uz', acceptLanguage: 'ru' })).toBe('en');
  expect(resolveLocale({ smartupLocale: 'uz', acceptLanguage: 'en-US,en;q=0.9' })).toBe('uz');
  expect(resolveLocale({ acceptLanguage: 'uz-Latn-UZ,uz;q=0.9,ru;q=0.8' })).toBe('uz');
  expect(resolveLocale({ acceptLanguage: 'en-GB,en;q=0.8,ru;q=0.5' })).toBe('en');
  expect(resolveLocale({})).toBe('ru');
});

test('неизвестные и искажённые значения не ломают выбор', () => {
  expect(resolveLocale({ userPref: 'xx', smartupLocale: '', acceptLanguage: 'de-DE,de;q=0.9' })).toBe('ru');
  expect(resolveLocale({ acceptLanguage: '*' })).toBe('ru');
  expect(resolveLocale({ acceptLanguage: ';;;,q=' })).toBe('ru');
  expect(resolveLocale({ userPref: 'RU' })).toBe('ru');
  expect(resolveLocale({ acceptLanguage: 'uz-Cyrl-UZ' })).toBe('uz');
});

test('язык браузера выбирается по весу, а не по порядку записи', () => {
  expect(resolveLocale({ acceptLanguage: 'ru;q=0.3,en;q=0.9' })).toBe('en');
  expect(resolveLocale({ acceptLanguage: 'de,fr;q=0.9,uz;q=0.1' })).toBe('uz');
  expect(resolveLocale({ acceptLanguage: 'en;q=0,ru;q=0.5' })).toBe('ru');
});

const pick = () => 'ru' as const;

test('адрес с известным языком не меняется', () => {
  expect(localizedPath('/ru', pick)).toBeNull();
  expect(localizedPath('/uz/tickets/42', pick)).toBeNull();
  expect(localizedPath('/en/', pick)).toBeNull();
});

test('адрес без языка получает язык посетителя', () => {
  expect(localizedPath('/', pick)).toBe('/ru');
  expect(localizedPath('/tickets', pick)).toBe('/ru/tickets');
  expect(localizedPath('/tickets/42', () => 'uz')).toBe('/uz/tickets/42');
});

test('неподдерживаемый язык в адресе заменяется языком посетителя', () => {
  expect(localizedPath('/de', pick)).toBe('/ru');
  expect(localizedPath('/de/tickets/42', pick)).toBe('/ru/tickets/42');
  expect(localizedPath('/fr-FR/ideas', pick)).toBe('/ru/ideas');
});

test('язык в другом регистре или с регионом приводится к коду портала', () => {
  expect(localizedPath('/RU', pick)).toBe('/ru');
  expect(localizedPath('/en-US/ideas', pick)).toBe('/en/ideas');
});

test('короткое имя раздела не принимается за язык', () => {
  expect(localizedPath('/kb', pick)).toBe('/ru/kb');
  expect(localizedPath('/kb/article-1', pick)).toBe('/ru/kb/article-1');
});

test('обычные имена разделов не принимаются за язык (ревью I4)', () => {
  for (const path of ['/my-tickets/42', '/new-request', '/it-support', '/no-access', '/id-card/7', '/sms', '/run', '/bin'])
    expect(localizedPath(path, pick), path).toBe(`/ru${path}`);
  expect(localizedPath('/uz-Cyrl/ideas', pick)).toBe('/uz/ideas');
  expect(localizedPath('/zh-Hant-TW/ideas', pick)).toBe('/ru/ideas');
});

test('разделы портала не теряются при перенаправлении', async () => {
  const { readdirSync } = await import('node:fs');
  const routes = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('['))
      .flatMap((entry) => (entry.name.startsWith('(') ? routes(`${dir}/${entry.name}`) : [entry.name]));
  const names = routes('src/app/[locale]');
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(localizedPath(`/${name}/x`, pick), name).toBe(`/ru/${name}/x`);
});

// Волна 7, T5 (FR-I18N-06): после входа язык страниц берётся из профиля, если на этом устройстве язык не выбирали.
test('после входа: выбор на устройстве, затем язык профиля, затем язык страницы входа', async () => {
  const { signedInPath } = await import('@/i18n/resolve-locale');
  // Язык профиля отличается от языка страницы входа, выбора на устройстве нет: адрес на языке профиля.
  expect(signedInPath({ pathname: '/ru/welcome', pageLocale: 'ru', profileLocale: 'uz', cookieLocale: undefined })).toBe('/uz/welcome');
  expect(signedInPath({ pathname: '/en', pageLocale: 'en', profileLocale: 'ru', cookieLocale: undefined })).toBe('/ru');
  expect(signedInPath({ pathname: '/ru/tickets/SUP-12', pageLocale: 'ru', profileLocale: 'en', cookieLocale: '' })).toBe('/en/tickets/SUP-12');
  // Язык выбран на этом устройстве: он важнее профиля, страница не меняется.
  expect(signedInPath({ pathname: '/ru/welcome', pageLocale: 'ru', profileLocale: 'uz', cookieLocale: 'ru' })).toBeNull();
  expect(signedInPath({ pathname: '/ru/welcome', pageLocale: 'ru', profileLocale: 'uz', cookieLocale: 'en' })).toBe('/en/welcome');
  // Язык совпадает, профиль пуст или испорчен: переходить некуда.
  expect(signedInPath({ pathname: '/uz/welcome', pageLocale: 'uz', profileLocale: 'uz', cookieLocale: undefined })).toBeNull();
  expect(signedInPath({ pathname: '/ru/welcome', pageLocale: 'ru', profileLocale: null, cookieLocale: undefined })).toBeNull();
  expect(signedInPath({ pathname: '/ru/welcome', pageLocale: 'ru', profileLocale: 'de', cookieLocale: 'xx' })).toBeNull();
});

test('после входа: язык в адресе возврата (next) тоже меняется', async () => {
  const { relocalize } = await import('@/i18n/resolve-locale');
  expect(relocalize('/ru/tickets/SUP-12?tab=files', 'ru', 'uz')).toBe('/uz/tickets/SUP-12?tab=files');
  expect(relocalize('/ru', 'ru', 'en')).toBe('/en');
  // Адрес без языка страницы не трогается.
  expect(relocalize('/help/a/12', 'ru', 'uz')).toBe('/help/a/12');
  expect(relocalize('/rubric', 'ru', 'uz')).toBe('/rubric');
});
