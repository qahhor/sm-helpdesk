import 'server-only';
import { createHmac } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { ClientActor, StaffActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { env } from '@/env';
import { LOCALES, type Locale } from '@/i18n/locales';
import { logEvent } from '@/lib/log';
import { consumeRateLimit, rateKey, type StaffContext } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { ticketSearchKey } from '@/modules/hdt/api/solution-source';
import type { ClientContext } from '@/modules/hdu/api/orgs';
import { hybridSearchTx, publishedForArticleTx } from '../core/search';
import { EmbeddingUnavailableError, getEmbedder } from '../embeddings';
import { HdkError } from '../error';
import { type KbAudience, ORG_COUNT_MIN, QUERY_EMBED_TIMEOUT_MS, SUGGEST_QUERY_MAX, SUGGEST_QUERY_MIN } from '../pref';
import { type ExactHit, rankHits, type RankedHit } from '../ranking';
import { kbArticles, kbDeflectionEvents, kbErrorSignatures, kbSignatureOrgs } from '../schema';
import { signatureFromText } from '../signature';

// Модуль hdk, слой api: подсказка решений и связанные решения (план M5, задача 10; ТЗ 11.6, FR-SOL-08..14, FR-AG-05,
// решения 5, 8, 12, 13, 17).
//
// Поиск идёт в транзакции актора: клиенту политики RLS отдают только строки индекса и копии с аудиторией clients,
// сотруднику ещё и internal. Текст запроса за пределы сервера не уходит (вектор считает локальный TEI) и не хранится:
// исход подсказки помнит только HMAC запроса. Сервис векторов не ответил за 150 мс: подсказка идёт по сигнатуре и
// словам, событие в журнале, форма работает. Клиент не читает сигнатуры, организации сигнатур и исходы: точное
// совпадение, число организаций и исход пишет и читает система, клиенту уходит только число и только от трёх.

const SYSTEM: SystemActor = { type: 'system', job: 'kb.suggest' };

/** Цепочка языков FR-SOL-10: язык пользователя, затем узбекский, русский, английский. */
export function localeChain(locale: Locale): Locale[] {
  return [locale, ...(['uz', 'ru', 'en'] as const).filter((l) => l !== locale)];
}

export type SearchMode = 'hybrid' | 'words';
export type FoundSolution = RankedHit & { orgCount: number | null };

type SearchInput = { text: string; signature: string | null; moduleId: string | null; locale: Locale; audiences: readonly KbAudience[] };

/** Вектор запроса не дольше 150 мс; иначе null и событие в журнале без текста (решение 5). */
async function queryVector(text: string): Promise<number[] | null> {
  const started = performance.now();
  try {
    const [vector] = await getEmbedder().embed([text], { timeoutMs: QUERY_EMBED_TIMEOUT_MS });
    return vector ?? null;
  } catch (error) {
    logEvent('warn', 'kb.suggest_embedder_unavailable', {
      reason: error instanceof EmbeddingUnavailableError ? error.reason : 'error',
      ms: Math.round(performance.now() - started),
    });
    return null;
  }
}

/** Точное совпадение сигнатуры: решение привязано к сигнатуре и видно актору; число организаций для клиента. */
async function exactMatch(actor: ClientActor | StaffActor, signature: string, locales: readonly Locale[], audiences: readonly KbAudience[]): Promise<{ hit: ExactHit | null; orgCount: number }> {
  const row = await withActor(SYSTEM, async (tx) => {
    const [found] = await tx
      .select({ signatureId: kbErrorSignatures.signatureId, articleId: kbErrorSignatures.articleId, orgCount: kbErrorSignatures.orgCount })
      .from(kbErrorSignatures)
      .where(eq(kbErrorSignatures.signature, signature))
      .limit(1);
    if (!found) return null;
    if (actor.type !== 'client') return found;
    // Организация клиента встретила эту ошибку (решение 8): число считается по различным организациям.
    await tx
      .insert(kbSignatureOrgs)
      .values({ signatureId: found.signatureId, orgId: actor.orgId })
      .onConflictDoUpdate({ target: [kbSignatureOrgs.signatureId, kbSignatureOrgs.orgId], set: { lastSeenOn: sql`now()` } });
    const [counted] = await tx
      .update(kbErrorSignatures)
      .set({ orgCount: sql`(select count(*) from ${kbSignatureOrgs} where ${kbSignatureOrgs.signatureId} = ${found.signatureId})::int` })
      .where(eq(kbErrorSignatures.signatureId, found.signatureId))
      .returning({ orgCount: kbErrorSignatures.orgCount });
    return { ...found, orgCount: counted?.orgCount ?? found.orgCount };
  });
  if (!row?.articleId) return { hit: null, orgCount: row?.orgCount ?? 0 };
  // Видимость решения проверяет политика актора: внутреннее и архивное клиенту не найдётся.
  const articleId = row.articleId;
  const hit = await withActor(actor, (tx) => publishedForArticleTx(tx, articleId, locales, audiences));
  return { hit, orgCount: row.orgCount };
}

/**
 * Поиск решений по разделу 11.6 от имени актора: точная сигнатура, слова, триграммы, смысл; не больше трёх уверенных.
 * Вызывают подсказка клиента и блок "Связанные решения" сотрудника.
 */
export async function searchSolutions(actor: ClientActor | StaffActor, input: SearchInput): Promise<{ items: FoundSolution[]; mode: SearchMode }> {
  const locales = localeChain(input.locale);
  // Одно слово не описание проблемы: по нему находится всё подряд (FR-SOL-09). Точное совпадение сигнатуры остаётся.
  const words = input.text.match(/[\p{L}\p{N}]{2,}/gu)?.length ?? 0;
  const vector = words < 2 ? null : await queryVector(input.text);
  const exact = input.signature ? await exactMatch(actor, input.signature, locales, input.audiences) : { hit: null, orgCount: 0 };
  const hits = words < 2 ? [] : await withActor(actor, (tx) => hybridSearchTx(tx, { text: input.text, vector, locales, audiences: input.audiences }));
  const ranked = rankHits(hits, { exact: exact.hit, moduleId: input.moduleId, locales });
  return {
    items: ranked.map((item) => ({ ...item, orgCount: item.exact && exact.orgCount >= ORG_COUNT_MIN ? exact.orgCount : null })),
    mode: vector ? 'hybrid' : 'words',
  };
}

// --- Подсказка на форме нового обращения (экран 8.3) ---

const suggestInput = z.strictObject({
  text: z.string().max(SUGGEST_QUERY_MAX),
  sessionId: z.uuid(),
  locale: z.enum(LOCALES),
  moduleId: z.uuid().nullable().optional(),
});

/** Решение в подсказке клиента: только то, что нужно ссылке и пометкам. */
export type ClientSuggestion = { number: number; slug: string; title: string; exact: boolean; orgCount: number | null };
export type ClientSuggestResult = { items: ClientSuggestion[]; limited: boolean };

/** HMAC запроса с ключом, выведенным из ENCRYPTION_KEY (решение 12): текст запроса не хранится. */
function queryHash(text: string): string {
  const key = createHmac('sha256', Buffer.from(env.ENCRYPTION_KEY, 'base64')).update('hdk:deflection-query').digest();
  return createHmac('sha256', key).update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * Строка исходов на сессию формы (решение 12): создаётся при первом показе с исходом left, при следующих показах
 * обновляются показанные решения и HMAC запроса. Чужую сессию (другой пользователь или организация) не трогает.
 * Показ решения в сессии считается в его счётчике один раз.
 */
async function noteShown(actor: ClientActor, sessionId: string, input: { text: string; signature: string | null; articleIds: string[] }): Promise<void> {
  await withActor(SYSTEM, async (tx) => {
    const [prev] = await tx
      .select({ userId: kbDeflectionEvents.userId, orgId: kbDeflectionEvents.orgId, shown: kbDeflectionEvents.shownArticleIds })
      .from(kbDeflectionEvents)
      .where(eq(kbDeflectionEvents.sessionId, sessionId))
      .for('update')
      .limit(1);
    if (prev && (prev.userId !== actor.userId || prev.orgId !== actor.orgId)) return;
    const values = { queryHash: queryHash(input.text), signature: input.signature, shownArticleIds: input.articleIds };
    if (prev) await tx.update(kbDeflectionEvents).set(values).where(eq(kbDeflectionEvents.sessionId, sessionId));
    else {
      const inserted = await tx
        .insert(kbDeflectionEvents)
        .values({ orgId: actor.orgId, userId: actor.userId, sessionId, zone: 'portal', ...values })
        .onConflictDoNothing()
        .returning({ id: kbDeflectionEvents.deflectionEventId });
      if (inserted.length === 0) return;
    }
    const fresh = input.articleIds.filter((id) => !(prev?.shown ?? []).includes(id));
    if (fresh.length > 0)
      await tx
        .update(kbArticles)
        .set({ shownCount: sql`${kbArticles.shownCount} + 1` })
        .where(inArray(kbArticles.articleId, fresh));
  });
}

/**
 * Подсказка "Похоже, это уже решали" на /tickets/new (FR-SOL-08..13): запрос от 3 до 500 знаков, 60 в минуту на
 * пользователя и 600 в час на организацию (решение 13). Сверх предела и при коротком запросе блок просто не
 * показывается: форма обращения работает всегда.
 */
export async function suggestForClient(ctx: ClientContext, input: unknown): Promise<ClientSuggestResult> {
  const parsed = suggestInput.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  const text = parsed.data.text.trim();
  if (text.length < SUGGEST_QUERY_MIN) return { items: [], limited: false };
  const perUser = await consumeRateLimit(rateKey('kb-suggest:user', ctx.actor.userId), RATE_RULES.kbSuggestPerUser);
  const perOrg = perUser.allowed ? await consumeRateLimit(rateKey('kb-suggest:org', ctx.actor.orgId), RATE_RULES.kbSuggestPerOrg) : perUser;
  if (!perUser.allowed || !perOrg.allowed) return { items: [], limited: true };
  const signature = signatureFromText(text);
  const { items } = await searchSolutions(ctx.actor, { text, signature, moduleId: parsed.data.moduleId ?? null, locale: parsed.data.locale, audiences: ['clients'] });
  if (items.length > 0) await noteShown(ctx.actor, parsed.data.sessionId, { text, signature, articleIds: items.map((i) => i.articleId) });
  return { items: items.map(({ number, slug, title, exact, orgCount }) => ({ number, slug, title, exact, orgCount })), limited: false };
}

const outcomeInput = z.strictObject({ sessionId: z.uuid() });

/** "Не помогло" в блоке подсказки (решение 12): исход сессии not_helped, если обращение ещё не создано. */
export async function recordSuggestNotHelped(ctx: ClientContext, input: unknown): Promise<void> {
  const parsed = outcomeInput.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  await withActor(SYSTEM, (tx) =>
    tx
      .update(kbDeflectionEvents)
      .set({ outcome: 'not_helped' })
      .where(
        and(
          eq(kbDeflectionEvents.sessionId, parsed.data.sessionId),
          eq(kbDeflectionEvents.userId, ctx.actor.userId),
          eq(kbDeflectionEvents.orgId, ctx.actor.orgId),
          ne(kbDeflectionEvents.outcome, 'ticket_created'),
        ),
      ),
  );
}

/** Обращение создано после показа подсказки (решение 12): исход ticket_created и ссылка на обращение. */
export async function recordSuggestTicket(ctx: ClientContext, input: { sessionId: unknown; ticketId: string }): Promise<void> {
  const parsed = outcomeInput.safeParse({ sessionId: input.sessionId });
  if (!parsed.success) return;
  await withActor(SYSTEM, (tx) =>
    tx
      .update(kbDeflectionEvents)
      .set({ outcome: 'ticket_created', ticketId: input.ticketId })
      .where(and(eq(kbDeflectionEvents.sessionId, parsed.data.sessionId), eq(kbDeflectionEvents.userId, ctx.actor.userId), eq(kbDeflectionEvents.orgId, ctx.actor.orgId))),
  );
}

// --- Связанные решения на странице обращения сотрудника (FR-AG-05) ---

export type RelatedSolution = { number: number; slug: string; title: string; locale: Locale; audience: KbAudience; exact: boolean };

/** Решения по сигнатуре и теме обращения среди решений для клиентов и "только через сотрудника". */
export async function relatedSolutions(ctx: StaffContext, input: unknown): Promise<RelatedSolution[]> {
  const parsed = z.strictObject({ ticketId: z.uuid() }).safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  const key = await ticketSearchKey(ctx.actor, { ticketId: parsed.data.ticketId });
  if (!key || key.title.trim().length < SUGGEST_QUERY_MIN) return [];
  const locale = (LOCALES as readonly string[]).includes(key.locale) ? (key.locale as Locale) : 'ru';
  const { items } = await searchSolutions(ctx.actor, {
    text: key.title.trim().slice(0, SUGGEST_QUERY_MAX),
    signature: key.errorSignature,
    moduleId: key.moduleId,
    locale,
    audiences: ['internal', 'clients'],
  });
  return items.map(({ number, slug, title, locale: l, audience, exact }) => ({ number, slug, title, locale: l, audience, exact }));
}
