import 'server-only';
import { and, asc, eq, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type SystemActor, withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { enqueue } from './jobs';
import { DOMAIN_EVENT_KINDS, type DomainEventKind } from './pref';
import { domainEvents } from './schema';

// Модуль hdc: события предметной области (FR-AUTO-02; план M8, задача 2, решение 3). Событие пишется в транзакции
// изменения обращения (emitEventTx): откатилось изменение, нет и события. Разбор (processEvents) ведёт фоновая
// задача automation.process: каждое событие своей транзакцией системы, строка блокируется FOR UPDATE SKIP LOCKED,
// обработчик и отметка разбора фиксируются вместе. Два процесса не берут одно событие, события одного обращения
// идут по порядку записи. В событии только идентификаторы и коды: текста переписки нет.

export type NewDomainEvent = {
  orgId: string;
  ticketId: string;
  kind: DomainEventKind;
  /** Подробности без текста переписки: источник, прежнее и новое значение, оценка, какой срок. */
  payload?: Record<string, unknown>;
  /** Событие порождено действием правила или макроса: правила на него не срабатывают (FR-AUTO-07). */
  byRule?: boolean;
};

export type DomainEvent = {
  eventId: string;
  orgId: string;
  ticketId: string;
  kind: DomainEventKind;
  payload: Record<string, unknown>;
  isByRule: boolean;
  createdOn: Date;
};

const KNOWN_KINDS: ReadonlySet<string> = new Set(DOMAIN_EVENT_KINDS);
/** Предел подробностей события: в них коды и идентификаторы, а не тексты. База держит 4000 байт. */
const MAX_PAYLOAD_CHARS = 1000;

/**
 * Пишет событие в транзакции действия над обращением (withActor клиента, сотрудника или системы). Идентификатор
 * задаёт база; клиенту строка событий не читается, поэтому функция ничего не возвращает.
 */
export async function emitEventTx(tx: Tx, event: NewDomainEvent): Promise<void> {
  if (!KNOWN_KINDS.has(event.kind)) throw new Error('События: неизвестный вид события');
  const payload = event.payload ?? {};
  if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) throw new Error('События: подробности события слишком большие');
  await tx.insert(domainEvents).values({ orgId: event.orgId, ticketId: event.ticketId, kind: event.kind, payload, isByRule: event.byRule === true });
}

/** Будит разбор после фиксации. Сбой постановки не бросает: события подберёт задача раз в минуту. */
export async function wakeAutomation(): Promise<void> {
  await enqueue('automation.process', {});
}

/** После стольких сбоев разбора событие снимается с очереди с отметкой ошибки: оно не держит следующие события обращения. */
export const EVENT_MAX_ATTEMPTS = 5;
const BATCH = 100;
/** Бюджет времени запуска: задача по расписанию идёт раз в минуту, следующий запуск не должен догнать этот. */
const PROCESS_BUDGET_MS = 50_000;

/**
 * Обработчик события. Работает в транзакции системы вместе с отметкой разбора: всё, что он записал через tx,
 * фиксируется или откатывается вместе с ней. Ошибка обработчика оставляет событие в очереди до следующего запуска.
 */
export type EventHandler = (tx: Tx, event: DomainEvent) => Promise<void>;

/** stopped: процесс останавливается; разбор прекращается между событиями, нетронутые события остаются в очереди. */
export type ProcessOptions = { batch?: number; budgetMs?: number; clock?: () => number; stopped?: () => boolean };

const columns = {
  eventId: domainEvents.eventId,
  orgId: domainEvents.orgId,
  ticketId: domainEvents.ticketId,
  kind: domainEvents.kind,
  payload: domainEvents.payload,
  isByRule: domainEvents.isByRule,
  createdOn: domainEvents.createdOn,
};

/**
 * У обращения нет более раннего неразобранного события. Такое событие видно и тогда, когда его строку держит другой
 * процесс: пока он не закончил, следующее событие того же обращения не берётся, и порядок по обращению сохраняется.
 */
const noEarlierPending = sql`not exists (
  select 1 from hdc_domain_events earlier
   where earlier.ticket_id = hdc_domain_events.ticket_id and earlier.processed_on is null and earlier.event_id < hdc_domain_events.event_id)`;

/** Вид ошибки без её текста: в тексте могут быть данные клиента. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'ошибка').slice(0, 100);

/**
 * Разбирает очередь событий: берёт пачку неразобранных по порядку записи и для каждого события открывает транзакцию,
 * блокирует строку (FOR UPDATE SKIP LOCKED: занятую другим процессом пропускает), вызывает обработчик и ставит
 * отметку разбора. Повторяет, пока очередь не опустеет, не кончится бюджет времени или процесс не начнёт остановку.
 * Сбой обработчика откатывает его транзакцию; счётчик попыток пишется отдельной транзакцией, после
 * EVENT_MAX_ATTEMPTS сбоев событие снимается с очереди. Событие, упавшее в этом запуске, до следующего не берётся.
 */
export async function processEvents(actor: SystemActor, handler: EventHandler, opts: ProcessOptions = {}): Promise<{ processed: number; failed: number }> {
  if (actor.type !== 'system') throw new Error('События разбирает только система');
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? PROCESS_BUDGET_MS);
  const batch = Math.max(1, opts.batch ?? BATCH);
  const done = () => clock() >= deadline || opts.stopped?.() === true;
  const result = { processed: 0, failed: 0 };
  const failedNow: string[] = [];

  while (!done()) {
    // Кандидаты без блокировки: блокирует и перепроверяет строку транзакция самого события.
    const candidates = await withActor(actor, (tx) =>
      tx
        .select({ eventId: domainEvents.eventId })
        .from(domainEvents)
        .where(and(isNull(domainEvents.processedOn), noEarlierPending, failedNow.length > 0 ? notInArray(domainEvents.eventId, failedNow) : undefined))
        .orderBy(asc(domainEvents.eventId))
        .limit(batch),
    );
    if (candidates.length === 0) break;
    let taken = 0;
    for (const { eventId } of candidates) {
      if (done()) return result;
      try {
        const handled = await withActor(actor, async (tx) => {
          const [event] = await tx
            .select(columns)
            .from(domainEvents)
            .where(and(eq(domainEvents.eventId, eventId), isNull(domainEvents.processedOn), noEarlierPending))
            .limit(1)
            .for('update', { skipLocked: true });
          // Событие взял или уже разобрал другой процесс, либо перед ним появилось более раннее событие обращения.
          if (!event) return false;
          await handler(tx, event);
          await tx.update(domainEvents).set({ processedOn: sql`now()` }).where(eq(domainEvents.eventId, eventId));
          return true;
        });
        if (handled) {
          result.processed++;
          taken++;
        }
      } catch (error) {
        result.failed++;
        taken++;
        failedNow.push(eventId);
        await noteFailure(actor, eventId, errorName(error));
      }
    }
    // Вся пачка занята другими процессами: они её и разберут, этот запуск не крутится вхолостую.
    if (taken === 0) break;
  }
  return result;
}

/** Сбой разбора: попытка считается отдельной транзакцией. После последней попытки событие снимается с очереди. */
async function noteFailure(actor: SystemActor, eventId: string, error: string): Promise<void> {
  const [row] = await withActor(actor, (tx) =>
    tx
      .update(domainEvents)
      .set({
        attempts: sql`${domainEvents.attempts} + 1`,
        lastError: error,
        processedOn: sql`case when ${domainEvents.attempts} + 1 >= ${EVENT_MAX_ATTEMPTS} then now() end`,
      })
      .where(and(eq(domainEvents.eventId, eventId), isNull(domainEvents.processedOn)))
      .returning({ attempts: domainEvents.attempts, kind: domainEvents.kind, processedOn: domainEvents.processedOn }),
  );
  if (!row) return;
  logEvent(row.processedOn ? 'error' : 'warn', row.processedOn ? 'automation.event_dropped' : 'automation.event_failed', { eventId, kind: row.kind, attempts: row.attempts, error });
}

/** Состояние очереди событий для наблюдения: сколько ждёт разбора и сколько секунд ждёт самое старое. */
export async function eventsState(actor: SystemActor, now: Date = new Date()): Promise<{ pending: number; lagSec: number }> {
  const [row] = await withActor(actor, (tx) =>
    tx
      .select({ pending: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${domainEvents.createdOn})::text` })
      .from(domainEvents)
      .where(isNull(domainEvents.processedOn)),
  );
  return { pending: row?.pending ?? 0, lagSec: row?.oldest ? Math.max(0, Math.round((now.getTime() - new Date(row.oldest).getTime()) / 1000)) : 0 };
}

/** Разобранные события хранятся столько суток (план M8, задача 2). */
export const EVENTS_KEEP_DAYS = 30;

/** Ночная очистка: разобранные события старше срока. Ждущие разбора остаются, сколько бы они ни ждали. */
export async function cleanupDomainEvents(actor: SystemActor, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - EVENTS_KEEP_DAYS * 86_400_000);
  const rows = await withActor(actor, (tx) => tx.delete(domainEvents).where(lt(domainEvents.processedOn, before)).returning({ eventId: domainEvents.eventId }));
  return rows.length;
}
