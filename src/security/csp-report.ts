import { z } from 'zod';

// Отчёты о нарушениях CSP (проверка main, S9). Политика до вехи M9 работает в режиме отчётов,
// браузер присылает нарушения на /api/csp-report. В журнал попадает только то, что нужно для
// исправления: директива, путь страницы без параметров (в них бывают токены ссылок) и источник
// без пути. Фрагменты кода и адреса целиком не пишутся.

/** Больше строк из одного запроса не пишется. */
const MAX_LINES = 10;
const PATH_MAX = 200;

const text = z.string().max(4096).optional();

/** Старый вид: заголовок report-uri, тип application/csp-report. */
const legacyReport = z.object({
  'csp-report': z.object({
    'document-uri': text,
    'violated-directive': text,
    'effective-directive': text,
    'blocked-uri': text,
  }),
});

/** Новый вид: Reporting API, тип application/reports+json, массив отчётов разных типов. */
const reportingItem = z.object({
  type: z.string(),
  body: z.object({ documentURL: text, effectiveDirective: text, blockedURL: text }).optional(),
});
const reportingBatch = z.array(z.unknown()).max(100);

type Violation = { document?: string; directive?: string; blocked?: string };

/** Путь страницы без параметров и якоря, только видимые знаки ASCII. */
function pathOf(value: string | undefined): string {
  if (!value) return '?';
  try {
    return new URL(value).pathname.replace(/[^\x21-\x7e]/g, '').slice(0, PATH_MAX) || '/';
  } catch {
    return '?';
  }
}

/** Источник: для адреса только схема и узел, иначе ключевое слово браузера (inline, eval, data). */
function sourceOf(value: string | undefined): string {
  if (!value) return '?';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
  } catch {
    // Не адрес: ключевое слово.
  }
  return /^[a-z-]{1,20}$/.test(value) ? value : '?';
}

const directiveOf = (value: string | undefined) => (value && /^[a-z-]{1,40}$/.test(value) ? value : '?');

function violations(body: unknown): Violation[] {
  const legacy = legacyReport.safeParse(body);
  if (legacy.success) {
    const r = legacy.data['csp-report'];
    return [{ document: r['document-uri'], directive: r['effective-directive'] ?? r['violated-directive'], blocked: r['blocked-uri'] }];
  }
  const batch = reportingBatch.safeParse(body);
  if (!batch.success) return [];
  return batch.data.flatMap((item) => {
    const parsed = reportingItem.safeParse(item);
    if (!parsed.success || parsed.data.type !== 'csp-violation' || !parsed.data.body) return [];
    const b = parsed.data.body;
    return [{ document: b.documentURL, directive: b.effectiveDirective, blocked: b.blockedURL }];
  });
}

/** Строки журнала по телу отчёта. Не отчёт: пусто. Не больше десяти строк. */
export function describeCspReports(body: unknown): string[] {
  return violations(body)
    .slice(0, MAX_LINES)
    .map((v) => `CSP: ${directiveOf(v.directive)} на ${pathOf(v.document)}, источник ${sourceOf(v.blocked)}`);
}
