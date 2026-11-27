import { phoneLike, scanText } from '@/modules/hdc/pref';
import type { SolutionDoc } from './doc-schema';

// Проверка текста решения перед публикацией (FR-SOL-04; план M5, задача 4, решение 14) и панель готовности (UX-W-07).
// Чистые функции без базы и сети: одни и те же правила подсвечивают находки в редакторе при каждом сохранении и
// проверяются ещё раз при публикации. Находки: телефоны, email, ИНН (9 цифр) и ПИНФЛ (14 цифр), длинные числа, адреса
// серверов с кодом клиента, внутренние имена (пакеты, таблицы, пути) и ссылки вне списка разрешённых доменов. Ссылка
// вне списка блокирует публикацию; остальные находки публикуются только после явного подтверждения сотрудником.
//
// Правила намеренно с запасом: лишняя находка стоит сотруднику одного подтверждения, пропущенный телефон клиента
// уходит всем клиентам портала.

export const FINDING_KINDS = ['phone', 'email', 'inn', 'pinfl', 'digits', 'server', 'internal', 'link'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
/** blockId: блок документа с находкой; null: заголовок решения. blocking: публикация невозможна (ссылка вне списка). */
export type Finding = { kind: FindingKind; blockId: string | null; text: string; blocking: boolean };

type Hit = { kind: Exclude<FindingKind, 'link'>; text: string; start: number };

/** Адрес почты; пробел по краям "@" не спасает адрес. */
const EMAIL = /[\p{L}\p{N}._%+-]+ ?@ ?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
/** Узел с портом (db.client.local:5432) и адрес IPv4 с портом или без. */
const HOST_WITH_PORT = /(?<![\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}:\d{2,5}(?!\d)/gi;
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?(?![\w.])/g;
/** Поддомен Smartup с кодом клиента: mycompany1.smartup.uz. Открытые поддомены Smartup находкой не считаются. */
const SMARTUP_HOST = /(?<![\w.-])([a-z0-9-]+)\.smartup\.(?:uz|online|ru|com)(?![\w-])/gi;
const PUBLIC_SMARTUP = new Set(['www', 'help', 'docs', 'blog', 'academy', 'support']);
/** Пути: файл с расширением исходников и настроек, абсолютный путь Unix к служебным каталогам, путь Windows. */
const SOURCE_PATH = /(?<![\w/\\.-])(?:[\w.-]+[/\\])*[\w-]+\.(?:pkb|pks|pck|sql|java|scala|kt|ts|tsx|js|xml|ya?ml|properties|sh|conf|ini|log)(?![\w])/gi;
const UNIX_PATH = /(?<![\w])\/(?:home|var|opt|etc|usr|srv|tmp|root|mnt|data)\/[^\s,;:()«»"']+/g;
const WINDOWS_PATH = /(?<![\w])[A-Za-z]:\\[^\s,;()«»"']+/g;
/** Пакет и процедура PL/SQL: Mkr_Api.Save_Order. */
const PACKAGE_CALL = /(?<![\w.])[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*(?![\w.])/g;
/** z-, x-, y-пакеты и таблицы Biruni и Smartup по приставкам модулей. */
const TABLE_NAME =
  /(?<![\w.])(?:[zxy]_[A-Za-z0-9]+_[A-Za-z0-9_]+|(?:md|mr|mk|mkr|mkw|mkf|mkcs|href|htt|hes|hln|hpd|hpr|hrm|hper|kauth|biruni|ms|mt|mf|ker|kdyn|kset|bmb|mbi|anor|ui|uit|hdc|hdu|hdr|hdt|hdk|hdn|hdw|hda)_[A-Za-z0-9_]{2,})(?![\w.])/gi;
/** Телефон: цифры группами через пробел, дефис, скобки, точку или косую черту (правило phoneLike), с плюсом или без. */
const PHONE = /(?<![\p{L}\p{N}_+])\+?\(?\p{Nd}{1,4}\)?(?:[\s./-]?\(?\p{Nd}{2,4}\)?){2,5}(?![\p{L}\p{N}_])/gu;
const DIGIT_RUN = /(?<!\p{Nd})\p{Nd}{7,}(?!\p{Nd})/gu;

const TRAILING = /[.,;:!?)\]]+$/;

/** Находки в одном куске текста, по порядку появления. Ссылки здесь не проверяются: это делает checkSolution. */
export function findInText(raw: string): { kind: Exclude<FindingKind, 'link'>; text: string }[] {
  // Полноширинные и другие цифры, "＠", невидимые знаки и соединители внутри числа не прячут находку (0057).
  const text = scanText(raw);
  const hits: Hit[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number) => !taken.some(([a, b]) => start < b && end > a);
  const scan = (pattern: RegExp, handle: (match: RegExpExecArray) => { kind: Hit['kind']; text: string; take?: boolean } | null | 'take') => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const value = match[0].replace(TRAILING, '');
      const end = start + value.length;
      if (!free(start, end)) continue;
      const result = handle(Object.assign(match, { 0: value }) as RegExpExecArray);
      if (result === null) continue;
      taken.push([start, end]);
      if (result !== 'take') hits.push({ kind: result.kind, text: result.text, start });
    }
  };
  const serverOfHost = (host: string, start: number) => {
    const bare = host.toLowerCase();
    const smartup = new RegExp(SMARTUP_HOST.source, 'i').exec(bare);
    if (smartup && !PUBLIC_SMARTUP.has(smartup[1]!) && smartup[0] === bare) hits.push({ kind: 'server', text: host, start });
  };

  scan(EMAIL, (m) => ({ kind: 'email', text: m[0] }));
  // Адрес в тексте: сам он не находка (ссылки проверяет checkSolution), но цифры пути не числа, а узел может быть
  // сервером клиента.
  scan(URL_IN_TEXT, (m) => {
    const host = hostOf(m[0]);
    if (host) {
      if (/:\d{2,5}$/.test(host) || /^(?:\d{1,3}\.){3}\d{1,3}/.test(host)) hits.push({ kind: 'server', text: host, start: m.index ?? 0 });
      else serverOfHost(host, m.index ?? 0);
    }
    return 'take';
  });
  scan(HOST_WITH_PORT, (m) => ({ kind: 'server', text: m[0] }));
  scan(IPV4, (m) =>
    m[0]
      .split(':')[0]!
      .split('.')
      .every((part) => Number(part) <= 255)
      ? { kind: 'server', text: m[0] }
      : null,
  );
  scan(SMARTUP_HOST, (m) => (PUBLIC_SMARTUP.has(m[1]!.toLowerCase()) ? null : { kind: 'server', text: m[0] }));
  scan(WINDOWS_PATH, (m) => ({ kind: 'internal', text: m[0] }));
  scan(UNIX_PATH, (m) => ({ kind: 'internal', text: m[0] }));
  scan(SOURCE_PATH, (m) => ({ kind: 'internal', text: m[0] }));
  scan(PACKAGE_CALL, (m) => ({ kind: 'internal', text: m[0] }));
  scan(TABLE_NAME, (m) => ({ kind: 'internal', text: m[0] }));
  scan(PHONE, (m) => {
    const digits = m[0].replace(/\D/g, '');
    const separated = /[\s()+./-]/.test(m[0]);
    if (digits.length < 9 || digits.length > 15 || !phoneLike(m[0], 9)) return null;
    if (!separated && !(digits.length === 12 && digits.startsWith('998'))) return null;
    return { kind: 'phone', text: m[0].trim() };
  });
  scan(DIGIT_RUN, (m) => ({ kind: m[0].length === 14 ? 'pinfl' : m[0].length === 9 ? 'inn' : 'digits', text: m[0] }));
  return hits.sort((a, b) => a.start - b.start).map(({ kind, text: value }) => ({ kind, text: value }));
}

/** Узел адреса ссылки без учётной записи, в нижнем регистре, с портом, если он есть. Не адрес: null. */
function hostOf(href: string): string | null {
  try {
    const url = new URL(/^www\./i.test(href) ? `https://${href}` : href);
    return url.host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Разрешён ли узел: совпадает с доменом из списка или его поддомен. Пустой список не разрешает ничего. */
export function isAllowedDomain(host: string, allowed: readonly string[]): boolean {
  const bare = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return allowed.some((domain) => bare === domain || bare.endsWith(`.${domain}`));
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Домен для настройки: из адреса или строки берётся узел; IP, localhost, маски и мусор отклоняются (null). */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') return null;
  const host = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  return DOMAIN.test(host) ? host : null;
}

type TextBlock = { blockId: string; text: string; hrefs: string[] };

/** Текстовые блоки документа (абзацы и заголовки, в том числе внутри шагов, списков, предупреждений и таблиц). */
function textBlocks(doc: SolutionDoc): TextBlock[] {
  const blocks: TextBlock[] = [];
  const walk = (node: { type: string; attrs?: { id?: unknown }; content?: unknown[] }) => {
    if ((node.type === 'paragraph' || node.type === 'heading') && typeof node.attrs?.id === 'string') {
      const hrefs: string[] = [];
      const text = (node.content ?? [])
        .map((child) => {
          const inline = child as { type: string; text?: string; marks?: { type: string; attrs?: { href?: string } }[] };
          if (inline.type === 'hardBreak') return '\n';
          for (const mark of inline.marks ?? []) if (mark.type === 'link' && mark.attrs?.href) hrefs.push(mark.attrs.href);
          return inline.text ?? '';
        })
        .join('');
      blocks.push({ blockId: node.attrs.id, text, hrefs });
      return;
    }
    for (const child of node.content ?? []) if (child && typeof child === 'object') walk(child as typeof node);
  };
  for (const block of doc.blocks) walk(block as unknown as { type: string });
  return blocks;
}

/** Текст документа без разметки: блоки через перевод строки. Для копии читателям и индекса (hdk_published.body_text). */
export function solutionBodyText(doc: SolutionDoc): string {
  return textBlocks(doc)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n');
}

/** Все находки заголовка и документа. Ссылка внутрь портала (/...) всегда разрешена. */
export function checkSolution(input: { title: string; doc: SolutionDoc }, opts: { allowedDomains: readonly string[] }): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (finding: Finding) => {
    const key = `${finding.kind}|${finding.blockId}|${finding.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  const linkHost = (blockId: string | null, href: string) => {
    if (href.startsWith('/') && !href.startsWith('//')) return;
    const host = hostOf(href);
    if (!host || !isAllowedDomain(host, opts.allowedDomains)) add({ kind: 'link', blockId, text: host ?? href, blocking: true });
  };
  const inspect = (blockId: string | null, raw: string, hrefs: readonly string[]) => {
    const text = scanText(raw);
    for (const hit of findInText(text)) add({ ...hit, blockId, blocking: false });
    for (const href of hrefs) {
      linkHost(blockId, href);
      const host = hostOf(href);
      if (host) for (const hit of findInText(href).filter((h) => h.kind === 'server')) add({ ...hit, blockId, blocking: false });
    }
    for (const match of text.matchAll(URL_IN_TEXT)) linkHost(blockId, match[0].replace(TRAILING, ''));
  };
  inspect(null, input.title, []);
  for (const block of textBlocks(input.doc)) inspect(block.blockId, block.text, block.hrefs);
  return findings;
}

export type Readiness = {
  items: { title: boolean; module: boolean; steps: boolean; checks: boolean; textRead: boolean };
  /** Можно публиковать (с подтверждением, если needsConfirm). */
  ready: boolean;
  /** Есть находки: публикация только после явного подтверждения. */
  needsConfirm: boolean;
  /** Есть ссылка вне списка: публикация невозможна, пока её не уберут. */
  blocked: boolean;
};

const hasText = (node: { type: string; text?: string; content?: unknown[] }): boolean =>
  (node.type === 'text' && (node.text ?? '').trim() !== '') || (node.content ?? []).some((child) => hasText(child as { type: string }));

/**
 * Панель готовности (UX-W-07): заголовок, модуль, хотя бы один шаг с текстом, проверка FR-SOL-04 и отметка "Текст
 * прочитан" для текста модели (решение 15; черновик из обращения появится в задаче 7, флаг уже есть у версии).
 */
/**
 * machineAllowed: машинный текст можно публиковать без отметки "Текст прочитан" (машинный перевод, сверенный с
 * оригиналом без расхождений, решение 9). Черновик из обращения такой поблажки не получает никогда (решение 15).
 */
export function readiness(input: { title: string; moduleId: string | null; doc: SolutionDoc; isMachine: boolean; findings: readonly Finding[]; machineAllowed?: boolean }): Readiness {
  const items = {
    title: input.title.trim() !== '',
    module: input.moduleId !== null,
    steps: input.doc.blocks.some((block) => block.type === 'step' && hasText(block as { type: string })),
    checks: input.findings.length === 0,
    textRead: !input.isMachine || input.machineAllowed === true,
  };
  const blocked = input.findings.some((finding) => finding.blocking);
  return {
    items,
    ready: items.title && items.module && items.steps && items.textRead && !blocked,
    needsConfirm: input.findings.length > 0 && !blocked,
    blocked,
  };
}

// --- Недоверенный текст (веха M5c, задача 10, решение 30; FR-CAND-09, угроза T33) ---

/** Вид находки недоверенного текста: команда оболочки или SQL, код в обратных кавычках или блоке. */
export type CommandFinding = { kind: 'command' | 'code'; text: string };

const SHELL = /(?:^|[\s(])(?:sudo\s+\S+|rm\s+-{1,2}\w*|curl\s+\S+|wget\s+\S+|powershell(?:\.exe)?\b|cmd(?:\.exe)?\s+\/\w|chmod\s+\S+|del\s+\/\w|reg\s+(?:add|delete)\s+\S+)[^\n]*/gi;
const SQL_COMMAND = /\b(?:drop\s+(?:table|database|index|view|schema|user)\s+\S+|delete\s+from\s+\S+|update\s+[\w.]+\s+set\s+\S+|truncate\s+(?:table\s+)?[\w.]+|insert\s+into\s+[\w.]+|alter\s+table\s+[\w.]+|grant\s+\w+\s+on\s+\S+)[^\n]*/gi;
const CODE_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;

/**
 * Команды и код в тексте: строки с sudo, rm, curl, wget, powershell, cmd, chmod, SQL drop, delete from, update ... set,
 * truncate, insert into, alter table и grant, обратные кавычки и блоки кода. Обычные слова ("удалите строку",
 * "обновите страницу", "delete the line") находкой не считаются: нужна форма команды.
 */
export function findCommands(raw: string): CommandFinding[] {
  const text = scanText(raw);
  const out: CommandFinding[] = [];
  const seen = new Set<string>();
  const push = (kind: CommandFinding['kind'], value: string) => {
    const clean = value.trim();
    const key = `${kind}:${clean}`;
    if (clean && !seen.has(key)) {
      seen.add(key);
      out.push({ kind, text: clean.slice(0, 300) });
    }
  };
  for (const m of text.matchAll(CODE_BLOCK)) push('code', m[0]);
  const withoutBlocks = text.replace(CODE_BLOCK, ' ');
  for (const m of withoutBlocks.matchAll(INLINE_CODE)) push('code', m[0]);
  for (const m of withoutBlocks.matchAll(SHELL)) push('command', m[0]);
  for (const m of withoutBlocks.matchAll(SQL_COMMAND)) push('command', m[0]);
  return out;
}

/** Находка недоверенного текста с отпечатком: вид и текст, по ним сотрудник ставит "Проверено". */
export type UntrustedFinding = { kind: 'phone' | 'email' | 'command' | 'code'; text: string; fingerprint: string };
