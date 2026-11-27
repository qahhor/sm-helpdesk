import 'server-only';
import { asc, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { FALLBACKS, type Locale, LOCALES } from '@/i18n/locales';
import { consumeRateLimit, rateKey } from '@/modules/hdc/api';
import { clientSolutionRefs } from '@/modules/hdk/api/refs';
import { errorSignatureOf } from '@/modules/hdk/api/signature-text';
import { createTicket, createWidgetTicket } from '@/modules/hdt/api';
import { ownProblemTicketTx, problemTicketTx } from '@/modules/hdt/api/known-problems';
import { activeProblemBySignatureTx } from '../core/problems';
import { HdpError } from '../error';
import { parseInput } from '../input';
import { isActiveProblem, PROBLEM_NUMBER_MAX, type ProblemStatus } from '../pref';
import { problemsPublic } from '../schema';

// Модуль hdp, слой api: что видит клиент (ТЗ FR-KP-05, 08, 09, 14.5; план M5c, задача 4, решения 2, 13-16). Всё читается
// от имени клиента из представления hdp_problems_public: без внутреннего названия, владельца, счётчиков, сигнатур и
// организаций, только показанные проблемы и только тексты сотрудника или принятые переводы. Сигнатура проблемы клиенту
// закрыта: какая активная проблема у ошибки, находит система, а показ всё равно идёт через представление от имени
// клиента. Обходной путь только решением, опубликованным для клиентов (hdk_published).

const SYSTEM: SystemActor = { type: 'system', job: 'problems.client' };

/** Карточка проблемы для клиента: баннер, блок в обращении, строка страницы проблем. */
export type PublicProblemCard = {
  number: number;
  status: ProblemStatus;
  publicTitle: string;
  publicBody: string;
  fixedOn: Date | null;
  workaround: { number: number; slug: string; title: string } | null;
};

type PublicRow = typeof problemsPublic.$inferSelect;

/** Строки представления от имени читателя по идентификаторам проблем (или все, если ids не задан). */
async function publicRowsTx(tx: Tx, ids?: readonly string[]): Promise<PublicRow[]> {
  if (ids && ids.length === 0) return [];
  return tx
    .select()
    .from(problemsPublic)
    .where(ids ? inArray(problemsPublic.problemId, [...ids]) : undefined)
    .orderBy(asc(problemsPublic.number));
}

/** Одна строка на проблему: язык читателя, затем запасные языки, затем любой показанный. */
function pickLocale(rows: readonly PublicRow[], locale: Locale): PublicRow[] {
  const order = [locale, ...FALLBACKS[locale]];
  const byProblem = new Map<string, PublicRow[]>();
  for (const row of rows) byProblem.set(row.problemId, [...(byProblem.get(row.problemId) ?? []), row]);
  return [...byProblem.values()].map((own) => {
    for (const lang of order) {
      const found = own.find((row) => row.locale === lang);
      if (found) return found;
    }
    return own[0]!;
  });
}

async function cards(actor: ClientActor, rows: readonly PublicRow[], locale: Locale): Promise<PublicProblemCard[]> {
  const chosen = pickLocale(rows, locale);
  const refs = await clientSolutionRefs(actor, { articleIds: chosen.flatMap((row) => (row.workaroundSolutionId ? [row.workaroundSolutionId] : [])), locale });
  return chosen.map((row) => {
    const ref = row.workaroundSolutionId ? refs.get(row.workaroundSolutionId) : undefined;
    return {
      number: row.number,
      status: row.status,
      publicTitle: row.publicTitle,
      publicBody: row.publicBody,
      fixedOn: row.fixedOn,
      workaround: ref ? { number: ref.number, slug: ref.slug, title: ref.title } : null,
    };
  });
}

async function cardOf(actor: ClientActor, problemId: string, locale: Locale): Promise<PublicProblemCard | null> {
  const rows = await withActor(actor, (tx) => publicRowsTx(tx, [problemId]));
  return (await cards(actor, rows, locale))[0] ?? null;
}

const textInput = z.strictObject({
  text: z.string().max(20_000),
  errorCode: z.string().max(64).optional(),
  errorText: z.string().max(2000).optional(),
  locale: z.enum(LOCALES),
});

/**
 * Баннер "Мы знаем об этой проблеме" (FR-KP-08, решение 13): сигнатура из кода и текста ошибки контекста или из
 * описания совпала с активной показанной проблемой. Исправленная и закрытая баннера не дают.
 */
export async function publicProblemForText(actor: ClientActor, input: unknown): Promise<PublicProblemCard | null> {
  const data = parseInput(textInput, input);
  const signature = errorSignatureOf({ text: data.text, errorCode: data.errorCode, errorText: data.errorText });
  if (!signature) return null;
  const found = await withActor(SYSTEM, (tx) => activeProblemBySignatureTx(tx, signature));
  if (!found) return null;
  const card = await cardOf(actor, found.problemId, data.locale);
  return card && isActiveProblem(card.status) ? card : null;
}

const ticketInput = z.strictObject({ ticketNumber: z.number().int().positive().max(999_999_999_999), locale: z.enum(LOCALES) });

/** Блок "Известная проблема" в обращении клиента (FR-KP-05, решение 15). Обращение невидимо или проблема скрыта: null. */
export async function publicProblemOfTicket(ctx: { actor: ClientActor }, input: unknown): Promise<PublicProblemCard | null> {
  const data = parseInput(ticketInput, input);
  const problemId = await withActor(ctx.actor, async (tx) => (await problemTicketTx(tx, { number: data.ticketNumber }))?.knownProblemId ?? null);
  return problemId ? cardOf(ctx.actor, problemId, data.locale) : null;
}

/** Страница "Известные проблемы" (FR-KP-09, решение 16): активные и исправленные за 30 суток, по номеру. */
export async function listPublicProblems(ctx: { actor: ClientActor }, input: unknown): Promise<PublicProblemCard[]> {
  const { locale } = parseInput(z.strictObject({ locale: z.enum(LOCALES) }), input);
  const rows = await withActor(ctx.actor, (tx) => publicRowsTx(tx));
  return (await cards(ctx.actor, rows, locale)).sort((a, b) => Number(isActiveProblem(b.status)) - Number(isActiveProblem(a.status)) || a.number - b.number);
}

const affectedInput = z.strictObject({
  problemNumber: z.number().int().positive().max(PROBLEM_NUMBER_MAX),
  locale: z.enum(LOCALES),
  description: z.string().max(20_000).optional(),
  context: z.strictObject({ errorCode: z.string().max(64).optional(), errorText: z.string().max(2000).optional(), moduleCode: z.string().max(64).optional() }).optional(),
  /** Платформа проверенного токена виджета; пусто: портал. Задаёт обработчик, а не тело запроса. */
  platform: z.enum(['web', 'android', 'ios']).optional(),
});

/** Одно нажатие на проблему за раз (14.5): второе одновременное ждёт первое. */
const AFFECTED_RULE = { limit: 1, windowSec: 10 };

/**
 * "Меня это тоже затронуло" (FR-KP-08, 14.5, решение 14): обращение тип bug, влияние major, тема из публичного названия,
 * описание из текста клиента, иначе из текста ошибки контекста, иначе название. Создаётся той же операцией, что
 * обычное обращение (пределы, сроки, сигнатура, помощник); не привязалось по сигнатуре: привязывается явно. Своё
 * обращение по этой проблеме уже есть: его номер, новое не создаётся.
 */
export async function reportAffected(ctx: { actor: ClientActor }, input: unknown): Promise<{ number: number; created: boolean }> {
  const data = parseInput(affectedInput, input);
  const rows = await withActor(ctx.actor, (tx) => tx.select().from(problemsPublic).where(eq(problemsPublic.number, data.problemNumber)));
  const [card] = await cards(ctx.actor, rows, data.locale);
  if (!card || !isActiveProblem(card.status)) throw new HdpError('not_found');
  const problemId = rows[0]!.problemId;
  const existing = await withActor(ctx.actor, (tx) => ownProblemTicketTx(tx, { authorId: ctx.actor.userId, problemId }));
  if (existing !== null) return { number: existing, created: false };
  const press = await consumeRateLimit(rateKey('problem-affected:user', `${ctx.actor.userId}:${data.problemNumber}`), AFFECTED_RULE);
  if (!press.allowed) throw new HdpError('rate_limited', { retryAfterSec: press.retryAfterSec });

  const context = data.context ?? {};
  const description = data.description?.trim() || [context.errorCode, context.errorText].filter(Boolean).join(': ') || card.publicTitle;
  // Без сигнатуры (или с другой) обращение привязывается явно внутри создания, до постановки помощника: задача первой
  // линии уже видит проблему и отвечает ею. Уже привязанное по сигнатуре не трогается.
  const created = data.platform
    ? await createWidgetTicket(ctx, { description, type: 'bug', impact: 'major', locale: data.locale, context: stripEmpty(context) }, { platform: data.platform, knownProblemId: problemId })
    : await createTicket(ctx, { description, title: card.publicTitle.slice(0, 200), type: 'bug', impact: 'major', locale: data.locale }, { knownProblemId: problemId });
  return { number: created.number, created: true };
}

const stripEmpty = (value: Record<string, string | undefined>) => Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string' && v !== ''));

/**
 * Известная проблема для ответа подсказки (решение 13): тело запроса подсказки (описание, код и текст ошибки, язык).
 * Неверное тело и отсутствие совпадения: null, подсказка работает как прежде.
 */
export async function problemForSuggest(actor: ClientActor, body: unknown): Promise<PublicProblemCard | null> {
  const parsed = z.object({ text: z.string().max(20_000).default(''), errorCode: z.string().max(64).optional(), errorText: z.string().max(2000).optional(), locale: z.enum(LOCALES) }).safeParse(body);
  if (!parsed.success) return null;
  return publicProblemForText(actor, { text: parsed.data.text, locale: parsed.data.locale, ...(parsed.data.errorCode ? { errorCode: parsed.data.errorCode } : {}), ...(parsed.data.errorText ? { errorText: parsed.data.errorText } : {}) });
}
