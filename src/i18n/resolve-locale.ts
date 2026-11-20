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

const NAMES = {
  language: new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }),
  script: new Intl.DisplayNames(['en'], { type: 'script', fallback: 'none' }),
  region: new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }),
};

function isKnown(kind: keyof typeof NAMES, code: string): boolean {
  try {
    return NAMES[kind].of(code) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Код языка из первого отрезка адреса, если отрезок записан как язык: de, fr-FR, uz-Cyrl, zh-Hant-TW.
 * Правило строгое, чтобы имя раздела не приняли за язык: двухбуквенный известный код языка,
 * затем необязательные известные письменность и регион. Отрезки my-tickets, it-support, sms, kb языком не считаются.
 */
function languageOf(segment: string): string | null {
  const match = /^([a-z]{2})(?:[-_]([a-z]{4}))?(?:[-_]([a-z]{2}|\d{3}))?$/i.exec(segment);
  if (!match) return null;
  const [, language, script, region] = match;
  if (!isKnown('language', language.toLowerCase())) return null;
  if (script && !isKnown('script', script[0].toUpperCase() + script.slice(1).toLowerCase())) return null;
  if (region && !isKnown('region', region.toUpperCase())) return null;
  return language.toLowerCase();
}

/**
 * Куда перенаправить адрес, в котором нет языка портала. Возвращает null, если адрес уже с языком.
 * Неподдерживаемый язык в адресе (/de/tickets) заменяется языком посетителя.
 */
export function localizedPath(pathname: string, pickLocale: () => Locale): string | null {
  const segments = pathname.split('/');
  const first = segments[1] ?? '';
  if (isLocale(first)) return null;

  const language = languageOf(first);
  if (language) {
    const locale = isLocale(language) ? language : pickLocale();
    const rest = segments.slice(2).join('/');
    return rest ? `/${locale}/${rest}` : `/${locale}`;
  }
  const tail = segments.slice(1).join('/');
  return tail ? `/${pickLocale()}/${tail}` : `/${pickLocale()}`;
}
