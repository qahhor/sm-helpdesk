import { scanText } from '@/modules/hdc/pref';
import { type FindingKind, findInText, isAllowedDomain } from '@/modules/hdk/api/text-checks';

// Модуль hdp, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

/** Номер проблемы для показа: KP-12 (раздел 8.12). */
export function problemRef(number: number): string {
  return `KP-${number}`;
}

/** Номер из записи KP-12, kp 12 или 12; иначе null. */
export function parseProblemRef(value: string): number | null {
  const match = /^\s*(?:kp[-\s]?)?(\d{1,9})\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 ? number : null;
}

/** Находка проверки публичного текста: правила решений, ссылка вне разрешённых доменов, название или ИНН организации. */
export type PublicTextFinding = { kind: Exclude<FindingKind, 'link'> | 'link' | 'org'; text: string };

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
/** Термин организации короче этого не ищется: "ООО" и "АО" есть в любом тексте. */
const ORG_TERM_MIN = 4;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hostOf(href: string): string | null {
  try {
    return new URL(href.startsWith('www.') ? `https://${href}` : href).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Проверка публичного текста (план M5c, решение 6; угроза T23). Названия и ИНН организаций ищутся без учёта регистра
 * целым словом; находка организации поглощает совпадающую находку правил (ИНН клиента это одна находка). Пустой список
 * доменов не разрешает ни одной внешней ссылки; ссылка внутрь портала (/...) не находка.
 */
export function checkPublicText(raw: string, opts: { orgTerms: readonly string[]; allowedDomains: readonly string[] }): PublicTextFinding[] {
  const text = scanText(raw);
  const findings: PublicTextFinding[] = [];
  const orgHits: string[] = [];
  for (const term of new Set(opts.orgTerms.map((t) => t.trim()).filter((t) => [...t].length >= ORG_TERM_MIN))) {
    const match = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(scanText(term))}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
    if (match) orgHits.push(match[0]);
  }
  for (const hit of orgHits) findings.push({ kind: 'org', text: hit });
  for (const hit of findInText(text)) if (!orgHits.some((org) => org.toLowerCase().includes(hit.text.toLowerCase()))) findings.push(hit);
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const host = hostOf(match[0].replace(/[.,;:!?)\]]+$/, ''));
    if (!host || !isAllowedDomain(host, opts.allowedDomains)) findings.push({ kind: 'link', text: host ?? match[0] });
  }
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.kind}|${f.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Код ошибки PostgreSQL: Drizzle внутри транзакции оборачивает ошибку базы в свою с причиной. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}
