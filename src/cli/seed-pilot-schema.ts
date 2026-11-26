import * as z from 'zod';
import { cleanUserText } from '@/modules/hdc/api/text';
import { safeParseSolutionDoc } from '@/modules/hdk/api/doc';

// Файл начальных данных пилота для команды hub seed:pilot (план подготовки M9, задача 6, решение 9). Схема строгая на
// каждом уровне: неизвестное поле отклоняет файл целиком. Данных клиентов в файле нет и быть не может: организации,
// пользователи клиентов и обращения появляются только из входа и работы (раздел "Общие ограничения" плана).
//
// Перечни ниже повторяют перечни модулей (слой pref недоступен команде консоли): тест tests/unit/seed-pilot-schema.test.ts
// сверяет их с модулями.

export const SEED_TICKET_TYPES = ['bug', 'question', 'service_request'] as const;
export const SEED_TAG_COLORS = ['gray', 'green', 'orange', 'purple', 'blue', 'teal', 'red', 'accent'] as const;
export const SEED_VOTE_MODES = ['per_user', 'per_org'] as const;
export const SEED_STAFF_ROLES = ['agent_l1', 'agent_l2', 'care', 'product', 'admin'] as const;
export const SEED_LOCALES = ['ru', 'uz', 'en'] as const;
export const SEED_AUDIENCES = ['internal', 'clients'] as const;
export const SEED_PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;

/** Поля с данными клиентов: их имя в файле называет причину отказа. */
export const CLIENT_DATA_FIELDS = ['organizations', 'orgs', 'clients', 'users', 'members', 'tickets', 'messages', 'ideas'] as const;

const text = (max: number) => z.string({ error: 'ожидается строка' }).trim().min(1, { error: 'пустая строка' }).max(max);
/**
 * Текст, который модуль хранит после очистки от невидимых знаков (шаблоны, памятки, теги): схема очищает так же,
 * иначе повторный запуск видел бы отличие от базы и писал запись заново.
 */
const cleanText = (max: number) => z.string({ error: 'ожидается строка' }).overwrite(cleanUserText).trim().min(1, { error: 'пустая строка' }).max(max);
const cleanLocales = (max: number) => z.strictObject({ ru: cleanText(max), uz: cleanText(max), en: cleanText(max) }, { error: 'ожидается объект с текстами ru, uz, en' });
/** Текст на трёх языках портала: каждый обязателен (решение 9, тест схемы). */
const allLocales = (max: number) => z.strictObject({ ru: text(max), uz: text(max), en: text(max) }, { error: 'ожидается объект с текстами ru, uz, en' });

const code = z
  .string({ error: 'ожидается строка' })
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/, { error: 'код: латинские буквы, цифры, _ . : -, до 100 знаков' });

const moduleRecord = z.strictObject({
  code,
  parentCode: code.nullable().optional(),
  name: allLocales(200),
  screens: z.array(z.strictObject({ code, name: allLocales(200) })).max(500).default([]),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'дата ГГГГ-ММ-ДД' }).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), {
  error: 'такой даты нет',
});

const holidayYear = z
  .strictObject({ year: z.int().min(2024).max(2100), dates: z.array(isoDate).max(60) })
  .refine((value) => value.dates.every((date) => date.startsWith(`${value.year}-`)), { error: 'дата не из этого года' })
  .refine((value) => new Set(value.dates).size === value.dates.length, { error: 'дата повторяется' });

const minutes = (max: number) => z.int().min(1).max(max);
const slaPolicy = z
  .strictObject({
    priority: z.enum(SEED_PRIORITIES),
    firstResponseMinutes: minutes(7 * 24 * 60),
    resolutionMinutes: minutes(60 * 24 * 60).optional(),
    resolutionDays: z.int().min(1).max(60).optional(),
    clock: z.enum(['business', '24x7']),
  })
  .refine((value) => (value.resolutionMinutes === undefined) !== (value.resolutionDays === undefined), { error: 'нужен один срок решения: в минутах или в днях' });

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { error: 'время ЧЧ:ММ' });
const hours = z
  .tuple([hhmm, hhmm])
  .nullable()
  .refine((value) => value === null || value[0] < value[1], { error: 'начало дня раньше конца' });
const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
/** График недели: ключ 0 воскресенье, хотя бы один рабочий день. */
const calendar = z.strictObject({
  timeZone: text(64).refine(isTimeZone, { error: 'часовой пояс IANA, например Asia/Tashkent' }),
  week: z
    .strictObject({ 0: hours, 1: hours, 2: hours, 3: hours, 4: hours, 5: hours, 6: hours })
    .refine((week) => Object.values(week).some((value) => value !== null), { error: 'нет ни одного рабочего дня' }),
});

const template = z.strictObject({
  shortcut: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'код шаблона: строчные латинские буквы, цифры и дефис, до 40 знаков' })),
  title: cleanText(120),
  body: cleanLocales(10000),
  module: code.nullable().default(null),
  enabled: z.boolean().default(true),
});

const playbook = z.strictObject({ module: code.nullable().default(null), type: z.enum(SEED_TICKET_TYPES), body: cleanText(10000) });

const tag = z.strictObject({
  name: z
    .string()
    .overwrite(cleanUserText)
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(1).max(40)),
  color: z.enum(SEED_TAG_COLORS).default('gray'),
});

const staffMember = z.strictObject({
  email: z.email({ error: 'адрес email' }).trim().toLowerCase(),
  name: text(100),
  role: z.enum(SEED_STAFF_ROLES),
  lead: z.boolean().default(false),
  /** Язык письма с приглашением. */
  locale: z.enum(SEED_LOCALES).default('ru'),
});

const solution = z.strictObject({
  /** Язык оригинала: черновик пишется на нём, переводы делает редактор решений. */
  locale: z.enum(SEED_LOCALES),
  title: text(200),
  audience: z.enum(SEED_AUDIENCES),
  module: code.nullable().default(null),
  doc: z.unknown().superRefine((value, ctx) => {
    const parsed = safeParseSolutionDoc(value);
    if (!parsed.success) ctx.addIssue({ code: 'custom', message: `документ решения: ${parsed.error.issues[0]?.message ?? 'неверный'}` });
  }),
});

const fileShape = z.strictObject({
  version: z.literal(1, { error: 'version: 1' }),
  modules: z.array(moduleRecord).min(1).max(5000).optional(),
  holidays: z.array(holidayYear).max(20).optional(),
  sla: z.strictObject({ policies: z.array(slaPolicy).max(4).optional(), calendar: calendar.optional() }).optional(),
  templates: z.array(template).max(500).optional(),
  playbooks: z.array(playbook).max(500).optional(),
  tags: z.array(tag).max(500).optional(),
  settings: z.strictObject({ ideasVoteMode: z.enum(SEED_VOTE_MODES).optional() }).optional(),
  staff: z.array(staffMember).max(200).optional(),
  solutions: z.array(solution).max(200).optional(),
});

export type SeedFile = z.infer<typeof fileShape>;
export type SeedModule = z.infer<typeof moduleRecord>;
export type SeedTemplate = z.infer<typeof template>;
export type SeedPlaybook = z.infer<typeof playbook>;
export type SeedSolution = z.infer<typeof solution>;

/** Где запись: раздел, номер с 1 и ключ записи, если он есть. */
function where(data: unknown, path: readonly PropertyKey[]): string {
  const [section, index, ...rest] = path;
  if (typeof section !== 'string') return 'файл';
  if (typeof index !== 'number') return [section, index, ...rest].filter((part) => part !== undefined).join('.');
  const record = (data as Record<string, unknown[]>)[section]?.[index] as Record<string, unknown> | undefined;
  const key = record && ['code', 'shortcut', 'email', 'name', 'title', 'year', 'priority', 'type'].map((field) => record[field]).find((value) => typeof value === 'string' || typeof value === 'number');
  const field = rest.length > 0 ? `: ${rest.join('.')}` : '';
  return `${section}, запись ${index + 1}${key !== undefined ? ` (${String(key)})` : ''}${field}`;
}

/** Повторы ключей внутри раздела: второй раз тот же ключ сделал бы запуск неоднозначным. */
function duplicates(data: SeedFile): string[] {
  const problems: string[] = [];
  const check = <T>(section: string, items: readonly T[] | undefined, key: (item: T) => string) => {
    const seen = new Map<string, number>();
    items?.forEach((item, index) => {
      const value = key(item);
      const first = seen.get(value);
      if (first !== undefined) problems.push(`${section}, запись ${index + 1} (${value}): тот же ключ уже в записи ${first + 1}`);
      else seen.set(value, index);
    });
  };
  check('modules', data.modules, (m) => m.code);
  check('holidays', data.holidays, (h) => String(h.year));
  check('sla.policies', data.sla?.policies, (p) => p.priority);
  check('templates', data.templates, (t) => t.shortcut);
  check('playbooks', data.playbooks, (p) => `${p.module ?? 'общая'}/${p.type}`);
  check('tags', data.tags, (t) => t.name.toLowerCase());
  check('staff', data.staff, (s) => s.email);
  check('solutions', data.solutions, (s) => `${s.locale}/${s.title.toLowerCase()}`);
  return problems;
}

/**
 * Разбор файла: данные или список проблем, каждая называет раздел, номер записи и её ключ. Поле с данными клиентов
 * (организации, обращения) отклоняет файл целиком с понятной причиной.
 */
export function parseSeedFile(content: string): { ok: true; data: SeedFile } | { ok: false; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    return { ok: false, problems: [`файл не JSON: ${error instanceof Error ? error.message : ''}`.trim()] };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const forbidden = Object.keys(raw).filter((key) => (CLIENT_DATA_FIELDS as readonly string[]).includes(key));
    if (forbidden.length > 0)
      return { ok: false, problems: forbidden.map((key) => `поле ${key} не допускается: данных клиентов в начальных данных нет, они появляются только из входа и работы`) };
  }
  const parsed = fileShape.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) =>
        issue.code === 'unrecognized_keys' ? `${where(raw, issue.path)}: неизвестные поля ${issue.keys.join(', ')}` : `${where(raw, issue.path)}: ${issue.message}`,
      ),
    };
  }
  const problems = duplicates(parsed.data);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, data: parsed.data };
}
