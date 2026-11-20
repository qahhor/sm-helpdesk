import { DEFAULT_LOCALE, isLocale, type Locale } from './locales';

/** Код языка портала из записи вида en-US, uz_Latn_UZ, RU. */
function toLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : null;
}

/** Первый поддерживаемый язык из заголовка Accept-Language с учётом весов q. */
function fromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { locale: toLocale(tag), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry): entry is { locale: Locale; weight: number; index: number } => entry.locale !== null && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return ranked[0]?.locale ?? null;
}

/**
 * Язык посетителя (FR-I18N-06). Порядок: настройка пользователя, язык в Smartup,
 * язык браузера, язык по умолчанию.
 */
export function resolveLocale(input: {
  userPref?: string | null;
  smartupLocale?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  return (
    toLocale(input.userPref) ??
    toLocale(input.smartupLocale) ??
    fromAcceptLanguage(input.acceptLanguage) ??
    DEFAULT_LOCALE
  );
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/** Похож ли первый отрезок адреса на код языка (de, fr-FR), а не на имя раздела (kb). */
function isLanguageTag(segment: string): boolean {
  if (!/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(segment)) return false;
  try {
    return languageNames.of(segment.split(/[-_]/)[0].toLowerCase()) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Куда перенаправить адрес, в котором нет языка портала. Возвращает null, если адрес уже с языком.
 * Неподдерживаемый язык в адресе (/de/tickets) заменяется языком посетителя.
 */
export function localizedPath(pathname: string, pickLocale: () => Locale): string | null {
  const segments = pathname.split('/');
  const first = segments[1] ?? '';
  if (isLocale(first)) return null;

  const known = toLocale(first);
  const rest = segments.slice(2).join('/');
  if (known || isLanguageTag(first)) {
    const locale = known ?? pickLocale();
    return rest ? `/${locale}/${rest}` : `/${locale}`;
  }
  const tail = segments.slice(1).join('/');
  return tail ? `/${pickLocale()}/${tail}` : `/${pickLocale()}`;
}
