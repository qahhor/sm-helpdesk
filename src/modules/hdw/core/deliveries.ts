import 'server-only';
import { and, arrayContains, asc, eq, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { logEvent } from '@/lib/log';
import { type DomainEvent, enqueue, writeAudit } from '@/modules/hdc/api';
import { moduleCodesTx, tagsByIdTx } from '@/modules/hdr/api';
import { ruleTicketFactsTx } from '@/modules/hdt/api/automation';
import { BlockedAddressError, type GuardedPost, guardedPostJson, LOOPBACK_HOSTS, OutboundTimeoutError } from '@/security/outbound';
import { getSecretBox } from '@/security/secret-box';
import { DELIVERIES_KEEP_DAYS, type DeliveryKind, WEBHOOK_BODY_BUDGET_BYTES, WEBHOOK_BODY_MAX_TAGS, WEBHOOK_CLAIM_PER_ENDPOINT, WEBHOOK_EVENTS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_MINUTES, WEBHOOK_TIMEOUT_MS } from '../pref';
import { type WebhookBody, webhookDeliveries, webhookEndpoints, webhookSecrets } from '../schema';
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signatureHeader } from '../webhook-sign';
import type { WebhookDeliverer } from './actions';
import { secretContext } from './webhooks';

// Модуль hdw, слой core: доставка исходящих вебхуков (FR-AUTO-10; план M8, задача 5, решения 9-11).
//
// Доставку ставит система в транзакции события: действие правила "вызвать вебхук" (enqueueRuleDelivery) и подписка
// адреса на вид события (enqueueEventDeliveriesTx). Откатился разбор события, нет и доставки. Одно событие уходит на
// адрес один раз (уникальный индекс hdw_webhook_deliveries_u1), тело несёт состояние обращения после правил.
//
// Отправка (dispatchWebhooksTx) устроена как очередь исходящих: короткая транзакция захватывает пачку (FOR UPDATE
// SKIP LOCKED, попытка +1, срок захвата 5 минут), запрос уходит вне транзакции через сетевой слой с проверкой адреса
// при соединении, итог пишется отдельной транзакцией. Процесс упал после отправки: строка вернётся после срока
// захвата и уйдёт с тем же идентификатором доставки, приёмник отличит повтор по заголовку X-Hub-Delivery.
//
// В теле запроса вид события, время и поля обращения: темы, описания, переписки, имён и адресов людей нет.

/**
 * Теги в теле доставки: по алфавиту, не больше WEBHOOK_BODY_MAX_TAGS и столько, чтобы тело уложилось в
 * WEBHOOK_BODY_BUDGET_BYTES (база держит 8000 байт, ограничение hdw_webhook_deliveries_c3). Список обрезан:
 * truncated. Тело с обрезанным списком всегда проходит ограничение: остальные поля короткие коды.
 */
export function fitTags(names: readonly string[], rest: (tags: string[]) => unknown): { tags: string[]; truncated: boolean } {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const tags = sorted.slice(0, WEBHOOK_BODY_MAX_TAGS);
  // Текст jsonb в базе чуть длиннее JSON.stringify (пробелы после двоеточий и запятых): запас заложен в бюджет.
  while (tags.length > 0 && Buffer.byteLength(JSON.stringify(rest(tags))) > WEBHOOK_BODY_BUDGET_BYTES) tags.pop();
  return { tags, truncated: tags.length < sorted.length };
}

/** Тело доставки об обращении. null: обращения нет. */
async function bodyOfTx(tx: Tx, input: { kind: DeliveryKind; occurredOn: Date; ticketId: string }): Promise<{ body: WebhookBody; orgId: string } | null> {
  const ticket = (await ruleTicketFactsTx(tx, [input.ticketId])).get(input.ticketId);
  if (!ticket) return null;
  const tags = await tagsByIdTx(tx, ticket.tagIds);
  const moduleCode = ticket.moduleId ? ((await moduleCodesTx(tx, [ticket.moduleId])).get(ticket.moduleId) ?? null) : null;
  const build = (names: string[], truncated: boolean): WebhookBody => ({
    event: input.kind,
    occurredOn: input.occurredOn.toISOString(),
    ticket: {
      number: ticket.number,
      ticketId: ticket.ticketId,
      orgId: ticket.orgId,
      status: ticket.status,
      priority: ticket.priority,
      type: ticket.type,
      queue: ticket.queue,
      moduleCode,
      tags: names,
      ...(truncated ? { tagsTruncated: true as const } : {}),
    },
  });
  const fitted = fitTags([...tags.values()].map((tag) => tag.name), (names) => build(names, true));
  return { orgId: ticket.orgId, body: build(fitted.tags, fitted.truncated) };
}

type NewDelivery = { endpointIds: readonly string[]; eventId: string | null; kind: DeliveryKind; occurredOn: Date; ticketId: string };

/**
 * Ставит доставки события на адреса. Доставка этого события на этот адрес уже стоит и ещё не уходила: её тело
 * заменяется свежим (состояние обращения после следующих правил), второй доставки не появляется.
 */
async function enqueueTx(tx: Tx, input: NewDelivery): Promise<number> {
  if (input.endpointIds.length === 0) return 0;
  const built = await bodyOfTx(tx, input);
  if (!built) return 0;
  const values = input.endpointIds.map((endpointId) => ({ orgId: built.orgId, endpointId, eventId: input.eventId, ticketId: input.ticketId, kind: input.kind, body: built.body }));
  if (input.eventId === null) {
    await tx.insert(webhookDeliveries).values(values);
    return values.length;
  }
  const rows = await tx
    .insert(webhookDeliveries)
    .values(values)
    .onConflictDoUpdate({
      target: [webhookDeliveries.endpointId, webhookDeliveries.eventId],
      targetWhere: sql`event_id is not null`,
      set: { body: built.body },
      setWhere: and(eq(webhookDeliveries.status, 'queued'), eq(webhookDeliveries.attempts, 0)),
    })
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return rows.length;
}

/**
 * Действие правила "вызвать вебхук": доставка в транзакции правила. Адреса нет (удалён после сохранения правила)
 * или он выключен: действие записывается невыполненным с кодом, остальные действия правила идут дальше.
 */
export const enqueueRuleDelivery: WebhookDeliverer = async (tx, input) => {
  const [endpoint] = await tx.select({ name: webhookEndpoints.name, isEnabled: webhookEndpoints.isEnabled }).from(webhookEndpoints).where(eq(webhookEndpoints.endpointId, input.endpointId)).limit(1);
  if (!endpoint) return { ok: false, detail: 'endpoint_missing' };
  if (!endpoint.isEnabled) return { ok: false, detail: 'endpoint_disabled' };
  await enqueueTx(tx, { endpointIds: [input.endpointId], eventId: input.eventId, kind: input.event, occurredOn: input.now, ticketId: input.ticketId });
  return { ok: true, name: endpoint.name };
};

const SUBSCRIBABLE: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);

/**
 * Подписки адресов: событие уходит каждому включённому адресу, который подписан на его вид. Вызывается разбором
 * событий после правил, в транзакции события. Событие, порождённое правилом, тоже уходит: это факт об обращении.
 */
export async function enqueueEventDeliveriesTx(tx: Tx, event: DomainEvent): Promise<number> {
  if (!SUBSCRIBABLE.has(event.kind)) return 0;
  const subscribed = await tx
    .select({ endpointId: webhookEndpoints.endpointId })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.isEnabled, true), arrayContains(webhookEndpoints.events, [event.kind])));
  return enqueueTx(tx, { endpointIds: subscribed.map((row) => row.endpointId), eventId: event.eventId, kind: event.kind as DeliveryKind, occurredOn: event.createdOn, ticketId: event.ticketId });
}

/** Будит отправку после фиксации. Сбой постановки не бросает: доставки подберёт задача раз в минуту. */
export async function wakeWebhooks(): Promise<void> {
  await enqueue('webhooks.dispatch', {});
}

/**
 * Срок доставки наступил к моменту now. Время в базе хранится в микросекундах, Date процесса знает только миллисекунды:
 * доставка, записанная в ту же миллисекунду, иначе ждала бы следующего запуска. Поэтому сравнение идёт с концом
 * миллисекунды now.
 */
const dueBy = (now: Date) => lt(webhookDeliveries.nextAttemptOn, new Date(now.getTime() + 1));

/** Есть ли доставки, которые пора отправлять: разбор событий будит отправку только тогда. */
export async function hasDueDeliveriesTx(actor: SystemActor, now: Date): Promise<boolean> {
  const rows = await withActor(actor, (tx) =>
    tx.select({ deliveryId: webhookDeliveries.deliveryId }).from(webhookDeliveries).where(and(eq(webhookDeliveries.status, 'queued'), dueBy(now))).limit(1),
  );
  return rows.length > 0;
}

// --- Отправка ---

const LEASE_MS = 5 * 60_000;
const BATCH = 50;
const MINUTE = 60_000;
/** Одновременных запросов в одном запуске: молчащий приёмник держит запрос до 10 секунд и не должен задерживать остальных. */
const DISPATCH_CONCURRENCY = 4;
/** Бюджет времени запуска: задача по расписанию идёт раз в минуту, следующий запуск не должен догнать этот. */
const DISPATCH_BUDGET_MS = 45_000;

export type WebhookDispatchOptions = {
  now?: Date;
  budgetMs?: number;
  concurrency?: number;
  clock?: () => number;
  /** Процесс останавливается: запуск прекращает работу между доставками и возвращает нетронутые в очередь. */
  stopped?: () => boolean;
  timeoutMs?: number;
  /** Подмена сетевого слоя в тестах. */
  post?: GuardedPost;
};
export type WebhookDispatchResult = { sent: number; failed: number; retried: number; cancelled: number };

type Claimed = { deliveryId: string; endpointId: string; kind: DeliveryKind; body: WebhookBody; attempts: number; url: string | null; isEnabled: boolean; sealed: string | null };

/**
 * Захват пачки: доставки помечаются попыткой и сроком захвата, другой запуск их не возьмёт. Адрес и секрет читаются
 * здесь же. От одного адреса в пачку идёт не больше WEBHOOK_CLAIM_PER_ENDPOINT самых давних доставок: адрес с
 * большой очередью не занимает пачку целиком (проверка вехи M8, находка I6). skip: адреса, которые в этом запуске
 * уже не ответили; их доставки подождут следующего запуска.
 */
async function claimBatch(actor: SystemActor, now: Date, skip: ReadonlySet<string>): Promise<Claimed[]> {
  return withActor(actor, async (tx) => {
    const due = and(eq(webhookDeliveries.status, 'queued'), dueBy(now), skip.size > 0 ? notInArray(webhookDeliveries.endpointId, [...skip]) : undefined);
    // Номер доставки в очереди своего адреса считает оконная функция; строки блокирует внешний запрос (оконная
    // функция с FOR UPDATE в одном запросе не сочетается).
    const ranked = tx
      .select({ deliveryId: webhookDeliveries.deliveryId, place: sql<number>`row_number() over (partition by ${webhookDeliveries.endpointId} order by ${webhookDeliveries.nextAttemptOn}, ${webhookDeliveries.deliveryId})`.as('place') })
      .from(webhookDeliveries)
      .where(due)
      .as('ranked');
    const rows = await tx
      .select({ deliveryId: webhookDeliveries.deliveryId, endpointId: webhookDeliveries.endpointId, kind: webhookDeliveries.kind, body: webhookDeliveries.body, attempts: webhookDeliveries.attempts })
      .from(webhookDeliveries)
      .where(and(due, inArray(webhookDeliveries.deliveryId, tx.select({ deliveryId: ranked.deliveryId }).from(ranked).where(lte(ranked.place, WEBHOOK_CLAIM_PER_ENDPOINT)))))
      .orderBy(asc(webhookDeliveries.nextAttemptOn))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (rows.length === 0) return [];
    await tx
      .update(webhookDeliveries)
      .set({ attempts: sql`${webhookDeliveries.attempts} + 1`, nextAttemptOn: new Date(now.getTime() + LEASE_MS) })
      .where(inArray(webhookDeliveries.deliveryId, rows.map((row) => row.deliveryId)));
    const ids = [...new Set(rows.map((row) => row.endpointId))];
    const endpoints = await tx
      .select({ endpointId: webhookEndpoints.endpointId, url: webhookEndpoints.url, isEnabled: webhookEndpoints.isEnabled, sealed: webhookSecrets.sealed })
      .from(webhookEndpoints)
      .leftJoin(webhookSecrets, eq(webhookSecrets.endpointId, webhookEndpoints.endpointId))
      .where(inArray(webhookEndpoints.endpointId, ids));
    const byId = new Map(endpoints.map((row) => [row.endpointId, row]));
    return rows.map((row) => {
      const endpoint = byId.get(row.endpointId);
      return { ...row, attempts: row.attempts + 1, url: endpoint?.url ?? null, isEnabled: endpoint?.isEnabled === true, sealed: endpoint?.sealed ?? null };
    });
  });
}

type Outcome = { kind: 'sent' } | { kind: 'cancelled' } | { kind: 'error'; error: string };

/** Один запрос приёмнику. Код неудачи короткий: ни тела ответа, ни текста ошибки в журнал доставок не идёт. */
async function deliver(row: Claimed, opts: { post: GuardedPost; timeoutMs: number; allowLoopback: boolean }): Promise<Outcome> {
  // Адрес выключили или удалили, пока доставка ждала: она отменяется, запрос не уходит.
  if (!row.url || !row.isEnabled) return { kind: 'cancelled' };
  let secret: string;
  try {
    if (!row.sealed) throw new Error('секрета нет');
    secret = getSecretBox().open(row.sealed, secretContext(row.endpointId));
  } catch {
    // Ключ шифрования сменили без перешифрования или строку повредили: без подписи запрос не уходит.
    return { kind: 'error', error: 'secret_unreadable' };
  }
  const raw = JSON.stringify(row.body);
  try {
    const { status } = await opts.post(
      { allowLoopback: opts.allowLoopback },
      row.url,
      { body: raw, timeoutMs: opts.timeoutMs, headers: { [SIGNATURE_HEADER]: signatureHeader(secret, Math.floor(Date.now() / 1000), raw), [EVENT_HEADER]: row.kind, [DELIVERY_HEADER]: row.deliveryId, 'user-agent': 'SmartupHub-Webhook/1' } },
    );
    // Успех только 2xx. Переадресация тоже неудача: по новому адресу портал не идёт.
    return status >= 200 && status < 300 ? { kind: 'sent' } : { kind: 'error', error: `http_${status}` };
  } catch (error) {
    if (error instanceof BlockedAddressError) return { kind: 'error', error: 'blocked_address' };
    if (error instanceof OutboundTimeoutError) return { kind: 'error', error: 'timeout' };
    return { kind: 'error', error: 'unreachable' };
  }
}

/** Адрес не ответил: не дождались ответа, соединение не установлено или запрещено. Ответ с кодом ошибки сюда не входит. */
const UNRESPONSIVE: ReadonlySet<string> = new Set(['timeout', 'unreachable', 'blocked_address']);

/**
 * Отправка одной доставки и запись итога. Итог пишется только в строку, которая ещё ждёт. Возвращает, ответил ли
 * адрес: неответивший адрес до конца запуска больше не берётся.
 */
async function sendRow(actor: SystemActor, now: Date, row: Claimed, opts: Parameters<typeof deliver>[1], result: WebhookDispatchResult): Promise<{ unresponsive: boolean }> {
  const outcome = await deliver(row, opts);
  const queuedRow = and(eq(webhookDeliveries.deliveryId, row.deliveryId), eq(webhookDeliveries.status, 'queued'));
  await withActor(actor, async (tx) => {
    if (outcome.kind === 'sent') {
      result.sent++;
      await tx.update(webhookDeliveries).set({ status: 'sent', lastError: null }).where(queuedRow);
    } else if (outcome.kind === 'cancelled') {
      result.cancelled++;
      // Попытки не было: счётчик возвращается.
      await tx.update(webhookDeliveries).set({ status: 'failed', lastError: 'endpoint_disabled', attempts: sql`${webhookDeliveries.attempts} - 1` }).where(queuedRow);
    } else if (row.attempts >= WEBHOOK_MAX_ATTEMPTS) {
      result.failed++;
      await tx.update(webhookDeliveries).set({ status: 'failed', lastError: outcome.error }).where(queuedRow);
      logEvent('warn', 'webhooks.delivery_failed', { deliveryId: row.deliveryId, endpointId: row.endpointId, error: outcome.error });
    } else {
      result.retried++;
      const pause = WEBHOOK_RETRY_MINUTES[row.attempts - 1] ?? WEBHOOK_RETRY_MINUTES[WEBHOOK_RETRY_MINUTES.length - 1];
      await tx.update(webhookDeliveries).set({ lastError: outcome.error, nextAttemptOn: new Date(now.getTime() + pause * MINUTE) }).where(queuedRow);
    }
  });
  return { unresponsive: outcome.kind === 'error' && UNRESPONSIVE.has(outcome.error) };
}

/**
 * Отправляет очередь доставок: берёт пачку (от каждого адреса понемногу), шлёт несколько запросов одновременно и
 * повторяет, пока очередь не опустеет, не кончится бюджет времени или процесс не начнёт остановку. Адрес, который не
 * ответил, до конца запуска пропускается: исправные адреса получают свои доставки в том же запуске. Неудача: повтор через 1, 5, 15, 60 и 240
 * минут, после шестой доставка получает failed (FR-AUTO-10: до пяти повторов). Доставки, взятые в пачку, но не
 * начатые, возвращаются в очередь без потраченной попытки.
 */
export async function dispatchWebhooksTx(actor: SystemActor, opts: WebhookDispatchOptions = {}): Promise<WebhookDispatchResult> {
  if (actor.type !== 'system') throw new Error('Вебхуки отправляет только система');
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? DISPATCH_BUDGET_MS);
  const concurrency = Math.max(1, opts.concurrency ?? DISPATCH_CONCURRENCY);
  const done = () => clock() >= deadline || opts.stopped?.() === true;
  const result: WebhookDispatchResult = { sent: 0, failed: 0, retried: 0, cancelled: 0 };
  // Портал на localhost (разработка и тесты): допускается локальный приёмник, как ложный сервер входа.
  const send = { post: opts.post ?? guardedPostJson, timeoutMs: opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS, allowLoopback: LOOPBACK_HOSTS.has(new URL(getEnv().HUB_URL).hostname) };

  // Адреса, которые в этом запуске не ответили: их доставки, взятые в пачку, возвращаются в очередь без попытки,
  // следующие пачки их не берут. Молчащий адрес занимает за запуск не больше одной своей доли пачки.
  const unresponsive = new Set<string>();
  while (!done()) {
    const claimed = await claimBatch(actor, now, unresponsive);
    if (claimed.length === 0) break;
    const untouched: string[] = [];
    const returned: string[] = [];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, claimed.length) }, async () => {
        for (let row = claimed.shift(); row; row = claimed.shift()) {
          if (done()) untouched.push(row.deliveryId);
          else if (unresponsive.has(row.endpointId)) returned.push(row.deliveryId);
          else if ((await sendRow(actor, now, row, send, result)).unresponsive) unresponsive.add(row.endpointId);
        }
      }),
    );
    if (returned.length > 0) await release(actor, now, returned);
    if (untouched.length > 0) {
      await release(actor, now, untouched);
      break;
    }
  }
  return result;
}

/** Доставки, взятые в пачку, но не начатые, возвращаются в очередь без потраченной попытки. */
async function release(actor: SystemActor, now: Date, deliveryIds: readonly string[]): Promise<void> {
  await withActor(actor, (tx) =>
    tx
      .update(webhookDeliveries)
      .set({ attempts: sql`${webhookDeliveries.attempts} - 1`, nextAttemptOn: now })
      .where(and(inArray(webhookDeliveries.deliveryId, [...deliveryIds]), eq(webhookDeliveries.status, 'queued'))),
  );
}

/** Ночная очистка: доставки старше срока хранения журнала. */
export async function cleanupDeliveriesTx(actor: SystemActor, now: Date): Promise<number> {
  const before = new Date(now.getTime() - DELIVERIES_KEEP_DAYS * 86_400_000);
  const rows = await withActor(actor, (tx) => tx.delete(webhookDeliveries).where(lt(webhookDeliveries.createdOn, before)).returning({ deliveryId: webhookDeliveries.deliveryId }));
  return rows.length;
}

/**
 * Замена ключа шифрования (команда hub secrets:reseal): секреты вебхуков перешифровываются текущим ключом.
 * Секрет, который не открывается ни одним ключом, не трогается: название его адреса возвращается в failed.
 */
export async function resealWebhookSecretsTx(actor: SystemActor): Promise<{ resealed: number; failed: string[] }> {
  const box = getSecretBox();
  return withActor(actor, async (tx) => {
    const rows = await tx
      .select({ endpointId: webhookSecrets.endpointId, sealed: webhookSecrets.sealed, name: webhookEndpoints.name })
      .from(webhookSecrets)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.endpointId, webhookSecrets.endpointId))
      .orderBy(asc(webhookSecrets.endpointId));
    let resealed = 0;
    const failed: string[] = [];
    for (const row of rows) {
      // Под try только шифрование: ошибка базы не должна выглядеть как "секрет не открывается".
      let next: string | null;
      try {
        const context = secretContext(row.endpointId);
        next = box.needsReseal(row.sealed, context) ? box.reseal(row.sealed, context) : null;
      } catch {
        failed.push(row.name);
        continue;
      }
      if (next === null) continue;
      await tx.update(webhookSecrets).set({ sealed: next }).where(eq(webhookSecrets.endpointId, row.endpointId));
      resealed += 1;
    }
    if (resealed > 0 || failed.length > 0) await writeAudit(tx, { action: 'secrets.resealed', objectType: 'webhook_secret', diff: { resealed, failed: failed.length } });
    return { resealed, failed };
  });
}
