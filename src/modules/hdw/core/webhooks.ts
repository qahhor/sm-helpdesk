import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { ticketNumbersTx } from '@/modules/hdt/api/automation';
import { getSecretBox } from '@/security/secret-box';
import { HdwError } from '../error';
import { DELIVERIES_PAGE, type DeliveryKind, type DeliveryStatus, MAX_WEBHOOKS, WEBHOOK_SECRET_BYTES, type WebhookEvent } from '../pref';
import { type WebhookBody, webhookDeliveries, webhookEndpoints, webhookSecrets } from '../schema';

// Модуль hdw, слой core: список адресов исходящих вебхуков (FR-AUTO-10, FR-ADM-11; план M8, задача 5, решение 9).
// Адреса читает и ведёт администратор: права держат политики RLS, код проверяет роль раньше, чтобы ответить кодом.
// Секрет подписи создаёт портал, показывает один раз и хранит зашифрованным: прочитать его может только система.
// Адрес уже проверен слоем api (https, внешний узел). Каждое изменение пишет запись журнала в той же транзакции.

export type WebhookEndpoint = { endpointId: string; name: string; url: string; events: WebhookEvent[]; isEnabled: boolean; modifiedOn: Date };
export type WebhookInput = { name: string; url: string; events: WebhookEvent[]; isEnabled: boolean };

const columns = {
  endpointId: webhookEndpoints.endpointId,
  name: webhookEndpoints.name,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  isEnabled: webhookEndpoints.isEnabled,
  modifiedOn: webhookEndpoints.modifiedOn,
};
const toEndpoint = (row: Omit<WebhookEndpoint, 'events'> & { events: string[] }): WebhookEndpoint => ({ ...row, events: row.events as WebhookEvent[] });

/** Место хранения секрета адреса: входит в проверку подлинности, секрет одного адреса не подходит другому. */
export const secretContext = (endpointId: string): string => `hdw_webhook_secrets:${endpointId}`;
/** Новый секрет подписи: 32 случайных байта строкой base64url. Эта строка и есть ключ HMAC. */
const newSecret = (): string => randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url');
/** Узел адреса для журнала: путь и параметры адреса в журнал не идут, в них бывают ключи приёмника. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

function requireAdmin(actor: StaffActor): void {
  if (actor.staffRole !== 'admin') throw new HdwError('forbidden');
}

export async function listWebhooksTx(actor: StaffActor): Promise<WebhookEndpoint[]> {
  requireAdmin(actor);
  const rows = await withActor(actor, (tx) => tx.select(columns).from(webhookEndpoints).orderBy(asc(sql`lower(${webhookEndpoints.name})`), asc(webhookEndpoints.endpointId)));
  return rows.map(toEndpoint);
}

export async function readWebhookTx(actor: StaffActor, endpointId: string): Promise<WebhookEndpoint | null> {
  requireAdmin(actor);
  const [row] = await withActor(actor, (tx) => tx.select(columns).from(webhookEndpoints).where(eq(webhookEndpoints.endpointId, endpointId)).limit(1));
  return row ? toEndpoint(row) : null;
}

/** Названия и включение адресов по идентификаторам в транзакции вызывающего (администратора или системы). */
export async function endpointsByIdTx(tx: Tx, endpointIds: readonly string[]): Promise<Map<string, { name: string; isEnabled: boolean }>> {
  const ids = [...new Set(endpointIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ endpointId: webhookEndpoints.endpointId, name: webhookEndpoints.name, isEnabled: webhookEndpoints.isEnabled }).from(webhookEndpoints).where(inArray(webhookEndpoints.endpointId, ids));
  return new Map(rows.map((row) => [row.endpointId, { name: row.name, isEnabled: row.isEnabled }]));
}

/**
 * Новый адрес с секретом подписи. Адрес, секрет и запись журнала пишутся одной транзакцией администратора.
 * Секрет возвращается открытым текстом единственный раз: дальше его не отдаёт ни одна точка входа.
 */
export async function createWebhookTx(actor: StaffActor, input: WebhookInput): Promise<{ endpointId: string; secret: string }> {
  requireAdmin(actor);
  const secret = newSecret();
  return withActor(actor, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hdw.webhooks'))`);
    const [total] = await tx.select({ n: sql<number>`count(*)::int` }).from(webhookEndpoints);
    if ((total?.n ?? 0) >= MAX_WEBHOOKS) throw new HdwError('too_many');
    const [created] = await tx.insert(webhookEndpoints).values(input).returning({ endpointId: webhookEndpoints.endpointId });
    if (!created) throw new Error('hdw: адрес вебхука не сохранён');
    await tx.insert(webhookSecrets).values({ endpointId: created.endpointId, sealed: getSecretBox().seal(secret, secretContext(created.endpointId)) });
    await writeAudit(tx, { action: 'webhook.created', objectType: 'webhook', objectId: created.endpointId, diff: { name: input.name, host: hostOf(input.url), events: input.events, isEnabled: input.isEnabled } });
    return { endpointId: created.endpointId, secret };
  });
}

/**
 * Правка адреса. Выключение отменяет его ждущие доставки: их пишет только система, поэтому отмена идёт второй
 * транзакцией сразу после правки; отправка и сама не шлёт на выключенный адрес. Нет адреса: not_found.
 */
export async function updateWebhookTx(actor: StaffActor, input: WebhookInput & { endpointId: string }): Promise<void> {
  requireAdmin(actor);
  const { endpointId, ...values } = input;
  await withActor(actor, async (tx) => {
    const [before] = await tx.select(columns).from(webhookEndpoints).where(eq(webhookEndpoints.endpointId, endpointId)).limit(1).for('update');
    if (!before) throw new HdwError('not_found');
    await tx.update(webhookEndpoints).set(values).where(eq(webhookEndpoints.endpointId, endpointId));
    await writeAudit(tx, {
      action: 'webhook.updated',
      objectType: 'webhook',
      objectId: endpointId,
      diff: { name: values.name, host: hostOf(values.url), events: values.events, isEnabled: values.isEnabled, urlChanged: before.url !== values.url },
    });
  });
  if (!values.isEnabled) await cancelQueuedTx(endpointId);
}

/** Ждущие доставки выключенного адреса получают failed с кодом endpoint_disabled. Пишет система. */
export async function cancelQueuedTx(endpointId: string): Promise<number> {
  const rows = await withActor({ type: 'system', job: 'settings.webhooks' }, (tx) =>
    tx
      .update(webhookDeliveries)
      .set({ status: 'failed', lastError: 'endpoint_disabled' })
      .where(and(eq(webhookDeliveries.endpointId, endpointId), eq(webhookDeliveries.status, 'queued')))
      .returning({ deliveryId: webhookDeliveries.deliveryId }),
  );
  return rows.length;
}

/**
 * Новый секрет вместо прежнего: прежний перестаёт действовать сразу. Секрет читает и меняет только система
 * (политика базы), право администратора проверено здесь, сотрудник назван в записи журнала той же транзакции.
 */
export async function rotateWebhookSecretTx(actor: StaffActor, endpointId: string): Promise<{ secret: string }> {
  requireAdmin(actor);
  const secret = newSecret();
  const sealed = getSecretBox().seal(secret, secretContext(endpointId));
  await withActor({ type: 'system', job: 'settings.webhooks', ip: actor.ip ?? null }, async (tx) => {
    const [endpoint] = await tx.select({ name: webhookEndpoints.name }).from(webhookEndpoints).where(eq(webhookEndpoints.endpointId, endpointId)).limit(1);
    if (!endpoint) throw new HdwError('not_found');
    await tx.insert(webhookSecrets).values({ endpointId, sealed }).onConflictDoUpdate({ target: webhookSecrets.endpointId, set: { sealed } });
    await writeAudit(tx, { action: 'webhook.secret_rotated', objectType: 'webhook', objectId: endpointId, diff: { name: endpoint.name, by: actor.userId } });
  });
  return { secret };
}

/** Удалить адрес вместе с секретом и журналом доставок. Нет адреса: not_found. */
export async function deleteWebhookTx(actor: StaffActor, endpointId: string): Promise<void> {
  requireAdmin(actor);
  await withActor(actor, async (tx) => {
    const [deleted] = await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.endpointId, endpointId)).returning({ name: webhookEndpoints.name, url: webhookEndpoints.url });
    if (!deleted) throw new HdwError('not_found');
    await writeAudit(tx, { action: 'webhook.deleted', objectType: 'webhook', objectId: endpointId, diff: { name: deleted.name, host: hostOf(deleted.url) } });
  });
}

const ZERO_ID = '00000000-0000-0000-0000-000000000000';
/** Образец тела для проверочной отправки: та же форма, данных настоящих обращений нет. */
export const sampleBody = (now: Date): WebhookBody => ({
  event: 'test',
  occurredOn: now.toISOString(),
  ticket: { number: 0, ticketId: ZERO_ID, orgId: ZERO_ID, status: 'new', priority: 'p3', type: 'question', queue: 'l1', moduleCode: null, tags: [] },
});

/**
 * Проверочная отправка: доставка с событием test и образцом тела. Доставки пишет только система, право
 * администратора проверено здесь. Выключенный адрес: endpoint_disabled. Нет адреса: not_found.
 */
export async function sendTestTx(actor: StaffActor, endpointId: string, now: Date): Promise<{ deliveryId: string }> {
  requireAdmin(actor);
  return withActor({ type: 'system', job: 'settings.webhooks', ip: actor.ip ?? null }, async (tx) => {
    const [endpoint] = await tx.select({ name: webhookEndpoints.name, isEnabled: webhookEndpoints.isEnabled }).from(webhookEndpoints).where(eq(webhookEndpoints.endpointId, endpointId)).limit(1);
    if (!endpoint) throw new HdwError('not_found');
    if (!endpoint.isEnabled) throw new HdwError('endpoint_disabled');
    const [created] = await tx.insert(webhookDeliveries).values({ endpointId, kind: 'test', body: sampleBody(now), nextAttemptOn: now }).returning({ deliveryId: webhookDeliveries.deliveryId });
    if (!created) throw new Error('hdw: проверочная доставка не поставлена');
    await writeAudit(tx, { action: 'webhook.test_sent', objectType: 'webhook', objectId: endpointId, diff: { name: endpoint.name, by: actor.userId } });
    return created;
  });
}

export type DeliveryRecord = {
  deliveryId: string;
  kind: DeliveryKind;
  ticketNumber: number | null;
  status: DeliveryStatus;
  attempts: number;
  /** Код последней неудачи: http_503, timeout и другие. Тела ответа приёмника здесь нет. */
  lastError: string | null;
  createdOn: Date;
  modifiedOn: Date;
  /** Когда уйдёт следующая попытка: имеет смысл у ждущей доставки. */
  nextAttemptOn: Date;
};

/** Страница журнала доставок адреса, новые сверху. cursor: идентификатор последней показанной строки. Нет адреса: not_found. */
export async function listDeliveriesTx(actor: StaffActor, endpointId: string, cursor: string | null): Promise<{ items: DeliveryRecord[]; nextCursor: string | null }> {
  requireAdmin(actor);
  return withActor(actor, async (tx) => {
    const [endpoint] = await tx.select({ endpointId: webhookEndpoints.endpointId }).from(webhookEndpoints).where(eq(webhookEndpoints.endpointId, endpointId)).limit(1);
    if (!endpoint) throw new HdwError('not_found');
    // По индексу hdw_webhook_deliveries_i1 (адрес, идентификатор): идентификатор uuidv7 растёт со временем.
    const rows = await tx
      .select({
        deliveryId: webhookDeliveries.deliveryId,
        kind: webhookDeliveries.kind,
        ticketId: webhookDeliveries.ticketId,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        lastError: webhookDeliveries.lastError,
        createdOn: webhookDeliveries.createdOn,
        modifiedOn: webhookDeliveries.modifiedOn,
        nextAttemptOn: webhookDeliveries.nextAttemptOn,
      })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.endpointId, endpointId), cursor ? lt(webhookDeliveries.deliveryId, cursor) : undefined))
      .orderBy(desc(webhookDeliveries.deliveryId))
      .limit(DELIVERIES_PAGE + 1);
    const page = rows.slice(0, DELIVERIES_PAGE);
    const numbers = await ticketNumbersTx(tx, page.flatMap((row) => (row.ticketId ? [row.ticketId] : [])));
    return {
      items: page.map(({ ticketId, ...row }) => ({ ...row, ticketNumber: ticketId ? (numbers.get(ticketId) ?? null) : null })),
      nextCursor: rows.length > DELIVERIES_PAGE ? (page.at(-1)?.deliveryId ?? null) : null,
    };
  });
}
