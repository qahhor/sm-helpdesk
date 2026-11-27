import 'server-only';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { FALLBACKS, type Locale, LOCALES } from '@/i18n/locales';
import { enqueue, type StaffContext, writeAudit } from '@/modules/hdc/api';
import { readAllowedDomains } from '@/modules/hdk/api/publish';
import { orgFacts } from '@/modules/hdu/api/orgs';
import { HdpError } from '../error';
import { parseInput } from '../input';
import {
  ANNOUNCEMENT_ARCHIVE_DAYS,
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_MAX_DAYS,
  ANNOUNCEMENT_SURFACES,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_WRITER_ROLES,
  type AnnouncementAudience,
  type AnnouncementKind,
} from '../pref';
import { announcementDismissals, announcements, announcementTranslations } from '../schema';
import { checkPublicText, pgErrorCode } from '../util';

// Модуль hdp, слой api: объявления (ТЗ 7.18, FR-ANN-01, 02, 04, FR-ADM-12; план M5c, задача 6, решение 24). Пишут care и
// admin с журналом аудита. Клиент видит начавшиеся объявления своей аудитории (политика базы): на страницах портала
// действующие, в архиве закончившиеся за 90 суток. Аудитория "модуль" на страницах портала у всех клиентов, над формой
// и в виджете только при выбранном или известном из контекста модуле. Закрытый баннер хранится в базе и не
// показывается тому, кто его закрыл, ни в портале, ни в виджете. Текст клиенту только от сотрудника или принятым
// переводом.

const DAY = 86_400_000;

function requireWriter(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || !(ANNOUNCEMENT_WRITER_ROLES as readonly string[]).includes(ctx.actor.staffRole)) throw new HdpError('forbidden');
}

const saveInput = z
  .strictObject({
    announcementId: z.uuid().optional(),
    kind: z.enum(ANNOUNCEMENT_KINDS),
    audience: z.enum(ANNOUNCEMENT_AUDIENCES),
    serverId: z.uuid().nullable().optional(),
    moduleId: z.uuid().nullable().optional(),
    startsOn: z.iso.datetime({ offset: true }),
    endsOn: z.iso.datetime({ offset: true }),
    locale: z.enum(LOCALES),
    title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
    body: z.string().trim().max(ANNOUNCEMENT_BODY_MAX),
  })
  .refine((v) => (v.audience === 'server') === Boolean(v.serverId) && (v.audience === 'module') === Boolean(v.moduleId))
  .refine((v) => {
    const start = Date.parse(v.startsOn);
    const end = Date.parse(v.endsOn);
    return end > start && end - start <= ANNOUNCEMENT_MAX_DAYS * DAY;
  });

async function assertText(texts: readonly string[]): Promise<void> {
  const allowedDomains = await readAllowedDomains();
  const findings = texts.flatMap((text) => checkPublicText(text, { orgTerms: [], allowedDomains }));
  if (findings.length > 0) throw new HdpError('text_findings', { findings });
}

/** Создать или изменить объявление: вид, период, аудитория и текст на языке автора (FR-ANN-01). */
export async function saveAnnouncement(ctx: StaffContext, input: unknown): Promise<{ announcementId: string }> {
  requireWriter(ctx);
  const data = parseInput(saveInput, input);
  await assertText([data.title, data.body]);
  const values = {
    kind: data.kind,
    audience: data.audience,
    serverId: data.audience === 'server' ? (data.serverId ?? null) : null,
    moduleId: data.audience === 'module' ? (data.moduleId ?? null) : null,
    startsOn: new Date(data.startsOn),
    endsOn: new Date(data.endsOn),
    sourceLocale: data.locale,
  };
  try {
    return await withActor(ctx.actor, async (tx) => {
      let announcementId = data.announcementId;
      if (announcementId) {
        const updated = await tx.update(announcements).set(values).where(eq(announcements.announcementId, announcementId)).returning({ id: announcements.announcementId });
        if (updated.length === 0) throw new HdpError('not_found');
      } else {
        const [row] = await tx.insert(announcements).values({ ...values, authorId: ctx.actor.userId }).returning({ id: announcements.announcementId });
        announcementId = row!.id;
      }
      const [current] = await tx
        .select({ title: announcementTranslations.title, body: announcementTranslations.body, isMachine: announcementTranslations.isMachine })
        .from(announcementTranslations)
        .where(and(eq(announcementTranslations.announcementId, announcementId), eq(announcementTranslations.locale, data.locale)))
        .limit(1);
      const text = { title: data.title, body: data.body, isMachine: false, acceptedBy: null, acceptedOn: null };
      await tx
        .insert(announcementTranslations)
        .values({ announcementId, locale: data.locale, ...text })
        .onConflictDoUpdate({ target: [announcementTranslations.announcementId, announcementTranslations.locale], set: text });
      // Текст оригинала изменился (или оригиналом стал другой язык): принятые переводы устарели (решение 0109).
      if (data.announcementId && (!current || current.isMachine || current.title !== data.title || current.body !== data.body)) await outdateTranslationsTx(tx, announcementId, data.locale);
      await writeAudit(tx, { action: 'announcement.saved', objectType: 'announcement', objectId: announcementId, diff: { kind: data.kind, audience: data.audience, startsOn: data.startsOn, endsOn: data.endsOn, locale: data.locale } });
      return { announcementId };
    });
  } catch (error) {
    // Нарушение внешнего ключа (нет сервера или модуля) или проверки периода: ошибка ввода.
    if (['23503', '23514'].includes(pgErrorCode(error) ?? '')) throw new HdpError('invalid_input');
    throw error;
  }
}

/**
 * Текст оригинала изменился (решение 0109): принятые машинные переводы на другие языки устарели. Принятие снимается,
 * клиент видит текст оригинала, пока сотрудник не примет свежий перевод. Тексты сотрудника не трогаются.
 */
async function outdateTranslationsTx(tx: Tx, announcementId: string, sourceLocale: Locale): Promise<void> {
  const rows = await tx
    .update(announcementTranslations)
    .set({ acceptedBy: null, acceptedOn: null })
    .where(
      and(
        eq(announcementTranslations.announcementId, announcementId),
        eq(announcementTranslations.isMachine, true),
        isNotNull(announcementTranslations.acceptedBy),
        ne(announcementTranslations.locale, sourceLocale),
      ),
    )
    .returning({ locale: announcementTranslations.locale });
  if (rows.length > 0) await writeAudit(tx, { action: 'announcement.translations_outdated', objectType: 'announcement', objectId: announcementId, diff: { locales: rows.map((r) => r.locale).sort() } });
}

const idInput = z.strictObject({ announcementId: z.uuid() });

/** Досрочное окончание (FR-ADM-12): конец показа ставится на сейчас; не начавшееся заканчивается, не начавшись. */
export async function endAnnouncement(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const { announcementId } = parseInput(idInput, input);
  await withActor(ctx.actor, async (tx) => {
    const [row] = await tx.select().from(announcements).where(eq(announcements.announcementId, announcementId)).limit(1).for('update');
    if (!row) throw new HdpError('not_found');
    const now = new Date();
    if (row.endsOn <= now) return;
    const startsOn = row.startsOn < now ? row.startsOn : new Date(now.getTime() - 1000);
    await tx.update(announcements).set({ startsOn, endsOn: now }).where(eq(announcements.announcementId, announcementId));
    await writeAudit(tx, { action: 'announcement.ended', objectType: 'announcement', objectId: announcementId, diff: { kind: row.kind } });
  });
}

const translationInput = z.strictObject({
  announcementId: z.uuid(),
  locale: z.enum(LOCALES),
  title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
  body: z.string().trim().max(ANNOUNCEMENT_BODY_MAX),
  acceptMachine: z.boolean().optional(),
});

/** Текст на языке: правка сотрудника или принятие машинного перевода без правки (решение 24, как у проблем). */
export async function saveAnnouncementTranslation(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(translationInput, input);
  await assertText([data.title, data.body]);
  await withActor(ctx.actor, async (tx) => {
    const [current] = await tx
      .select()
      .from(announcementTranslations)
      .where(and(eq(announcementTranslations.announcementId, data.announcementId), eq(announcementTranslations.locale, data.locale)))
      .limit(1);
    const [head] = await tx.select({ id: announcements.announcementId, sourceLocale: announcements.sourceLocale }).from(announcements).where(eq(announcements.announcementId, data.announcementId)).limit(1);
    if (!head) throw new HdpError('not_found');
    const accepting = data.acceptMachine === true && current?.isMachine === true && current.title === data.title && current.body === data.body;
    const text = { title: data.title, body: data.body, isMachine: accepting, acceptedBy: accepting ? ctx.actor.userId : null, acceptedOn: accepting ? new Date() : null };
    await tx
      .insert(announcementTranslations)
      .values({ announcementId: data.announcementId, locale: data.locale, ...text })
      .onConflictDoUpdate({ target: [announcementTranslations.announcementId, announcementTranslations.locale], set: text });
    if (!accepting && data.locale === head.sourceLocale && (!current || current.title !== data.title || current.body !== data.body)) await outdateTranslationsTx(tx, data.announcementId, data.locale);
    await writeAudit(tx, { action: 'announcement.saved', objectType: 'announcement', objectId: data.announcementId, diff: { locale: data.locale, accepted: accepting } });
  });
}

/** Машинный перевод на язык задачей announcements.translate (решение 24). */
export async function requestAnnouncementTranslation(ctx: StaffContext, input: unknown): Promise<void> {
  requireWriter(ctx);
  const data = parseInput(z.strictObject({ announcementId: z.uuid(), locale: z.enum(LOCALES) }), input);
  const row = await withActor(ctx.actor, async (tx) => (await tx.select({ sourceLocale: announcements.sourceLocale }).from(announcements).where(eq(announcements.announcementId, data.announcementId)).limit(1))[0]);
  if (!row) throw new HdpError('not_found');
  if (row.sourceLocale === data.locale) throw new HdpError('invalid_input');
  await enqueue('announcements.translate', { announcementId: data.announcementId, locale: data.locale });
}

export type AnnouncementState = 'scheduled' | 'active' | 'ended';

export type StaffAnnouncement = {
  announcementId: string;
  kind: AnnouncementKind;
  audience: AnnouncementAudience;
  serverId: string | null;
  moduleId: string | null;
  sourceLocale: Locale;
  startsOn: Date;
  endsOn: Date;
  state: AnnouncementState;
  texts: { locale: Locale; title: string; body: string; isMachine: boolean; accepted: boolean }[];
};

const stateOf = (row: { startsOn: Date; endsOn: Date }, now: Date): AnnouncementState => (row.startsOn > now ? 'scheduled' : row.endsOn > now ? 'active' : 'ended');

/** Список у сотрудника (FR-ADM-12): запланированные, действующие и закончившиеся, новые сверху. */
export async function listStaffAnnouncements(ctx: StaffContext): Promise<StaffAnnouncement[]> {
  if (ctx.actor.type !== 'staff') throw new HdpError('forbidden');
  const now = new Date();
  return withActor(ctx.actor, async (tx) => {
    const rows = await tx.select().from(announcements).orderBy(desc(announcements.startsOn)).limit(200);
    const texts = rows.length === 0 ? [] : await tx.select().from(announcementTranslations).where(inArray(announcementTranslations.announcementId, rows.map((r) => r.announcementId)));
    return rows.map((row) => ({
      announcementId: row.announcementId,
      kind: row.kind,
      audience: row.audience,
      serverId: row.serverId,
      moduleId: row.moduleId,
      sourceLocale: row.sourceLocale,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      state: stateOf(row, now),
      texts: texts
        .filter((t) => t.announcementId === row.announcementId)
        .map((t) => ({ locale: t.locale, title: t.title, body: t.body, isMachine: t.isMachine, accepted: t.acceptedBy !== null })),
    }));
  });
}

/** Объявление для клиента: только то, что написал сотрудник, на языке клиента или запасном. */
export type ClientAnnouncement = { announcementId: string; kind: AnnouncementKind; audience: AnnouncementAudience; moduleId: string | null; startsOn: Date; endsOn: Date; locale: Locale; title: string; body: string };

async function clientAnnouncementsTx(tx: Tx, locale: Locale, where: ReturnType<typeof and>): Promise<ClientAnnouncement[]> {
  const rows = await tx.select().from(announcements).where(where).orderBy(asc(announcements.startsOn));
  if (rows.length === 0) return [];
  const texts = await tx.select().from(announcementTranslations).where(inArray(announcementTranslations.announcementId, rows.map((r) => r.announcementId)));
  const order = [locale, ...FALLBACKS[locale]];
  return rows.flatMap((row) => {
    const own = texts.filter((t) => t.announcementId === row.announcementId);
    const text = order.map((l) => own.find((t) => t.locale === l)).find(Boolean) ?? own.find((t) => t.locale === row.sourceLocale) ?? own[0];
    if (!text) return [];
    return [{ announcementId: row.announcementId, kind: row.kind, audience: row.audience, moduleId: row.moduleId, startsOn: row.startsOn, endsOn: row.endsOn, locale: text.locale, title: text.title, body: text.body }];
  });
}

const activeInput = z.strictObject({ locale: z.enum(LOCALES), surface: z.enum(ANNOUNCEMENT_SURFACES), moduleId: z.uuid().optional() });

/**
 * Действующие объявления для баннеров (FR-ANN-02): без закрытых этим пользователем. Аудитория "модуль" на страницах
 * портала всегда, над формой и в виджете только при этом модуле (решение 24). Без кеша: читается при каждом показе.
 */
export async function activeAnnouncements(actor: ClientActor, input: unknown): Promise<ClientAnnouncement[]> {
  const data = parseInput(activeInput, input);
  const now = new Date();
  return withActor(actor, async (tx) => {
    const dismissed = new Set((await tx.select({ id: announcementDismissals.announcementId }).from(announcementDismissals)).map((r) => r.id));
    const moduleScope =
      data.surface === 'portal' ? undefined : data.moduleId ? or(sql`${announcements.audience} <> 'module'`, eq(announcements.moduleId, data.moduleId)) : sql`${announcements.audience} <> 'module'`;
    const list = await clientAnnouncementsTx(tx, data.locale, and(lte(announcements.startsOn, now), gt(announcements.endsOn, now), moduleScope));
    return list.filter((a) => !dismissed.has(a.announcementId));
  });
}

/** Архив /announcements (FR-ANN-04): действующие и закончившиеся за 90 суток, новые сверху; закрытые тоже видны. */
export async function announcementArchive(ctx: { actor: ClientActor }, input: unknown): Promise<ClientAnnouncement[]> {
  const { locale } = parseInput(z.strictObject({ locale: z.enum(LOCALES) }), input);
  const now = new Date();
  const list = await withActor(ctx.actor, (tx) => clientAnnouncementsTx(tx, locale, and(lte(announcements.startsOn, now), gt(announcements.endsOn, new Date(now.getTime() - ANNOUNCEMENT_ARCHIVE_DAYS * DAY)))));
  return list.sort((a, b) => b.startsOn.getTime() - a.startsOn.getTime());
}

/** Закрыть баннер (FR-ANN-04): только за себя и только видимое объявление. Повтор ничего не меняет. */
export async function dismissAnnouncement(ctx: { actor: ClientActor }, input: unknown): Promise<void> {
  const { announcementId } = parseInput(idInput, input);
  await withActor(ctx.actor, async (tx) => {
    const [visible] = await tx.select({ id: announcements.announcementId }).from(announcements).where(eq(announcements.announcementId, announcementId)).limit(1);
    if (!visible) throw new HdpError('not_found');
    await tx.insert(announcementDismissals).values({ userId: ctx.actor.userId, announcementId }).onConflictDoNothing();
  });
}

/**
 * Действующее объявление "сбой" для помощника (FR-ANN-03, решение 23; задача 7): аудитория "все", сервер организации
 * обращения или модуль обращения. Модуль обращения не задан: сбой модуля не подходит.
 */
export async function activeOutage(system: SystemActor, input: { orgId: string; moduleId: string | null }): Promise<{ announcementId: string } | null> {
  const [org] = await orgFacts(system, [input.orgId]);
  const now = new Date();
  const scope = or(
    eq(announcements.audience, 'all'),
    org?.serverId ? and(eq(announcements.audience, 'server'), eq(announcements.serverId, org.serverId)) : sql`false`,
    input.moduleId ? and(eq(announcements.audience, 'module'), eq(announcements.moduleId, input.moduleId)) : sql`false`,
  );
  const [row] = await withActor(system, (tx) =>
    tx
      .select({ announcementId: announcements.announcementId })
      .from(announcements)
      .where(and(eq(announcements.kind, 'outage'), lte(announcements.startsOn, now), gt(announcements.endsOn, now), scope))
      .orderBy(desc(announcements.startsOn))
      .limit(1),
  );
  return row ?? null;
}

/**
 * Одно объявление для сообщения Теза о сбое (решение 23) на языке клиента: только начавшееся объявление аудитории
 * клиента (политика базы), текст сотрудника или принятый перевод. Невидимое или удалённое: null.
 */
export async function clientAnnouncement(ctx: { actor: ClientActor }, input: unknown): Promise<(ClientAnnouncement & { ended: boolean }) | null> {
  const data = parseInput(z.strictObject({ announcementId: z.uuid(), locale: z.enum(LOCALES) }), input);
  const [row] = await withActor(ctx.actor, (tx) => clientAnnouncementsTx(tx, data.locale, and(eq(announcements.announcementId, data.announcementId))));
  return row ? { ...row, ended: row.endsOn.getTime() <= Date.now() } : null;
}
