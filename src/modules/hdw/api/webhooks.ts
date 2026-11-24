import 'server-only';
import * as z from 'zod';
import { getEnv } from '@/env';
import { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from '@/modules/hdc/api';
import { cleanUserText } from '@/modules/hdc/pref';
import { LOOPBACK_HOSTS, publicUrlOrNull } from '@/security/outbound';
import { wakeWebhooks } from '../core/deliveries';
import {
  createWebhookTx,
  type DeliveryRecord,
  deleteWebhookTx,
  listDeliveriesTx,
  listWebhooksTx,
  readWebhookTx,
  rotateWebhookSecretTx,
  sendTestTx,
  updateWebhookTx,
  type WebhookEndpoint,
} from '../core/webhooks';
import { HdwError } from '../error';
import { WEBHOOK_EVENTS, WEBHOOK_NAME_MAX, WEBHOOK_URL_MAX } from '../pref';

// Модуль hdw, слой api: адреса исходящих вебхуков для экрана администратора (FR-AUTO-10, FR-ADM-11; план M8,
// задача 5). Сотрудник из проверенной сессии, вход по схеме. Читает и меняет адреса только администратор; изменение
// требует входа не старше 15 минут (ТЗ 14.3). Адрес принимается, только если он https и ведёт на внешний узел;
// при каждом соединении его ещё раз проверяет сетевой слой. Секрет подписи возвращают только создание адреса и
// смена секрета, один раз.

export type { DeliveryRecord, WebhookEndpoint } from '../core/webhooks';
export { DELIVERIES_PAGE, type DeliveryKind, type DeliveryStatus, MAX_WEBHOOKS, WEBHOOK_EVENTS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_NAME_MAX, WEBHOOK_URL_MAX, type WebhookEvent } from '../pref';

function requireAdmin(ctx: StaffContext): void {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdwError('forbidden');
}

function requireFreshAdmin(ctx: StaffContext): void {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdwError('stale_session');
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdwError('invalid_input');
  return parsed.data;
}

const fields = {
  name: z.string().overwrite(cleanUserText).trim().min(1).max(WEBHOOK_NAME_MAX),
  url: z.string().trim().min(1).max(WEBHOOK_URL_MAX),
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .max(WEBHOOK_EVENTS.length)
    .transform((list) => [...new Set(list)]),
};
const createInput = z.strictObject({ ...fields, isEnabled: z.boolean().default(true) });
const updateInput = z.strictObject({ endpointId: z.uuid(), ...fields, isEnabled: z.boolean() });
const idInput = z.strictObject({ endpointId: z.uuid() });
const deliveriesInput = z.strictObject({ endpointId: z.uuid(), cursor: z.uuid().nullable().optional() });

/**
 * Адрес приёмника в том виде, в каком он сохраняется. Отказ invalid_url: не https, с учётной записью, узел
 * служебный, адрес цифрами из внутренней сети или имя, которое не разрешается либо ведёт во внутреннюю сеть.
 * Портал на localhost (разработка и тесты) допускает локальный приёмник.
 */
async function publicUrl(raw: string): Promise<string> {
  const url = await publicUrlOrNull(raw, { allowLoopback: LOOPBACK_HOSTS.has(new URL(getEnv().HUB_URL).hostname) });
  if (!url) throw new HdwError('invalid_url');
  return url.toString();
}

/** Все адреса по названию. Только администратор. */
export async function listWebhooks(ctx: StaffContext): Promise<WebhookEndpoint[]> {
  requireAdmin(ctx);
  return listWebhooksTx(ctx.actor);
}

/** Адрес по идентификатору. Нет такого или идентификатор негоден: null. Секрета в ответе нет. */
export async function readWebhook(ctx: StaffContext, endpointId: unknown): Promise<WebhookEndpoint | null> {
  requireAdmin(ctx);
  const id = z.uuid().safeParse(endpointId);
  return id.success ? readWebhookTx(ctx.actor, id.data) : null;
}

/** Добавить адрес. Возвращает секрет подписи: показать его администратору можно только сейчас. */
export async function createWebhook(ctx: StaffContext, input: unknown): Promise<{ endpointId: string; secret: string }> {
  requireFreshAdmin(ctx);
  const data = parse(createInput, input);
  return createWebhookTx(ctx.actor, { ...data, url: await publicUrl(data.url) });
}

/** Изменить название, адрес, подписки и включение. Выключение отменяет ждущие доставки адреса. */
export async function updateWebhook(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  const data = parse(updateInput, input);
  await updateWebhookTx(ctx.actor, { ...data, url: await publicUrl(data.url) });
}

/** Сменить секрет подписи: прежний перестаёт действовать сразу, новый возвращается один раз. */
export async function rotateWebhookSecret(ctx: StaffContext, input: unknown): Promise<{ secret: string }> {
  requireFreshAdmin(ctx);
  return rotateWebhookSecretTx(ctx.actor, parse(idInput, input).endpointId);
}

/** Удалить адрес вместе с секретом и журналом доставок. Правила, которые его вызывали, запишут действие невыполненным. */
export async function deleteWebhook(ctx: StaffContext, input: unknown): Promise<void> {
  requireFreshAdmin(ctx);
  await deleteWebhookTx(ctx.actor, parse(idInput, input).endpointId);
}

/** Проверочная отправка: событие test с образцом тела без данных обращений. Итог виден в журнале доставок. */
export async function sendTestWebhook(ctx: StaffContext, input: unknown): Promise<{ deliveryId: string }> {
  requireFreshAdmin(ctx);
  const result = await sendTestTx(ctx.actor, parse(idInput, input).endpointId, new Date());
  await wakeWebhooks();
  return result;
}

/** Журнал доставок адреса, новые сверху, по 50. cursor: nextCursor предыдущей страницы. */
export async function listWebhookDeliveries(ctx: StaffContext, input: unknown): Promise<{ items: DeliveryRecord[]; nextCursor: string | null }> {
  requireAdmin(ctx);
  const data = parse(deliveriesInput, input);
  return listDeliveriesTx(ctx.actor, data.endpointId, data.cursor ?? null);
}
