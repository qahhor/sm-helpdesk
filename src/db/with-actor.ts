import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { type AppDb, getAppDb, type Tx } from './client';
import { logEvent } from '@/lib/log';
import type { AgentTool } from '@/modules/hda/pref';

// Весь доступ к данным идёт через withActor (ТЗ, раздел 11.1). Функция открывает транзакцию
// и сообщает базе, от чьего имени выполняется запрос. Значения живут до конца транзакции,
// поэтому приём безопасен при пуле соединений.
//
// Актор строится только из проверенной сессии или проверенного токена виджета.
// Ни одно его поле, кроме адреса посетителя для журнала аудита, не берётся из запроса. Адрес берётся
// из заголовка доверенного прокси (CLIENT_IP_HEADER, решение 0020) и прав не даёт.

export type ClientActor = {
  type: 'client';
  userId: string;
  orgId: string;
  orgRole: 'client_user' | 'client_admin';
  /** Проверенный адрес посетителя: база ставит его в журнал аудита (миграция 0009). */
  ip?: string | null;
};
export type StaffActor = {
  type: 'staff';
  userId: string;
  staffRole: 'agent_l1' | 'agent_l2' | 'care' | 'product' | 'admin';
  /** Проверенный адрес посетителя: база ставит его в журнал аудита (миграция 0009). */
  ip?: string | null;
};
/** ip: адрес запроса, если система действует по запросу человека (принятие приглашения, подтверждение адреса). */
export type SystemActor = { type: 'system'; job: string; ip?: string | null };
/**
 * AI-сотрудник, который работает через сервер MCP (веха M8b, решение 5). Строится только из токена, проверенного в базе
 * на входе сервера MCP. userId: учётная запись agent_bot токена (автор записей агента в служебных колонках и журнале
 * аудита). ticketId: обращение токена запуска (FR-AGT-12), у основного токена пусто.
 */
export type AgentActor = {
  type: 'agent';
  tokenId: string;
  userId: string;
  tools: readonly AgentTool[];
  ticketId: string | null;
  /** Проверенный адрес запроса к серверу MCP: база ставит его в журнал аудита. */
  ip?: string | null;
};
export type Actor = ClientActor | StaffActor | SystemActor | AgentActor;

/** Предел времени запроса в транзакции актора agent (план M8b, решение 31). */
export const AGENT_STATEMENT_TIMEOUT = '5s';

export type WithActor = <T>(actor: Actor, fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** Транзакция от имени актора на заданном подключении. Её же использует withIdentity (подключение hub_auth). */
/** Транзакция дольше этого порога пишется в журнал событием db.slow_tx (аудит 23.11.2026, находки O1 и P4). */
export const SLOW_TX_MS = 250;
const slow = globalThis as typeof globalThis & { __hubSlowTxMs?: number | null };

/** Порог медленной транзакции для тестов. null возвращает обычный. */
export function setSlowTxMsForTests(ms: number | null): void {
  slow.__hubSlowTxMs = ms;
}

/** Длительность и актор, без текста запросов и значений: по событию ищут медленное место, данные в журнал не идут. */
function noteSlowTx(actor: Actor, startedAt: number): void {
  const ms = Math.round(performance.now() - startedAt);
  if (ms < (slow.__hubSlowTxMs ?? SLOW_TX_MS)) return;
  logEvent('warn', 'db.slow_tx', { ms, actor: actor.type, ...(actor.type === 'system' ? { job: actor.job } : {}) });
}

/** Какому пулу принадлежит транзакция: hub_app (withActor) или hub_auth (withIdentity). */
export type TxPool = 'app' | 'auth';
/** Транзакция, открытая внутри другой: внешняя держит своё соединение, пока внутренняя ждёт своё. */
export type NestedTx = { outer: TxPool; inner: TxPool; actor: Actor['type']; job: string | null; stack: string };

// Открытая транзакция текущей цепочки вызовов. По ней видно вложенную транзакцию (проверка качества, Q2, Q11, Q12):
// обратный вызов withActor позвал функцию, которая сама открывает транзакцию. Внешняя при этом держит соединение
// hub_app и ждёт свободное соединение второго пула: под нагрузкой это очередь и взаимная блокировка пулов.
const txScope = new AsyncLocalStorage<{ pool: TxPool }>();
const nested = globalThis as typeof globalThis & { __hubNestedTxHook?: ((found: NestedTx) => void) | null };

/** Тесты получают каждую вложенную транзакцию с местом вызова (tests/integration/setup/each.ts). null убирает. */
export function setNestedTxHookForTests(hook: ((found: NestedTx) => void) | null): void {
  nested.__hubNestedTxHook = hook;
}

function noteNestedTx(outer: TxPool, inner: TxPool, actor: Actor): void {
  const job = actor.type === 'system' ? actor.job : null;
  // В журнале только пулы и актор. Уровень debug: известные места записаны долгом, новые ловит тест.
  logEvent('debug', 'db.nested_tx', { outer, inner, actor: actor.type, ...(job ? { job } : {}) });
  const hook = nested.__hubNestedTxHook;
  if (hook) hook({ outer, inner, actor: actor.type, job, stack: new Error().stack ?? '' });
}

export function createWithActor(db: AppDb, pool: TxPool = 'app'): WithActor {
  return async (actor, fn) => {
    const outer = txScope.getStore();
    if (outer) noteNestedTx(outer.pool, pool, actor);
    // Отсчёт с начала транзакции, а не с ожидания свободного соединения: иначе при занятом пуле каждая транзакция
    // выглядела бы медленной (итоговая проверка W0, M11).
    let startedAt: number | null = null;
    try {
      return await txScope.run({ pool }, () => db.transaction(async (tx) => {
        startedAt = performance.now();
        await tx.execute(sql`
          select set_config('app.actor_type', ${actor.type}, true),
                 set_config('app.user_id', ${'userId' in actor ? actor.userId : ''}, true),
                 set_config('app.org_id', ${actor.type === 'client' ? actor.orgId : ''}, true),
                 set_config('app.org_role', ${actor.type === 'client' ? actor.orgRole : ''}, true),
                 set_config('app.staff_role', ${actor.type === 'staff' ? actor.staffRole : ''}, true),
                 set_config('app.client_ip', ${'ip' in actor && actor.ip && isIP(actor.ip) !== 0 ? actor.ip : ''}, true),
                 set_config('app.agent_token_id', ${actor.type === 'agent' ? actor.tokenId : ''}, true),
                 set_config('app.agent_ticket_id', ${actor.type === 'agent' ? (actor.ticketId ?? '') : ''}, true)`);
        // Запрос агента не держит базу дольше 5 секунд (решение 31): медленный инструмент не мешает работе портала.
        if (actor.type === 'agent') await tx.execute(sql`select set_config('statement_timeout', ${AGENT_STATEMENT_TIMEOUT}, true)`);
        return fn(tx);
      }));
    } catch (error) {
      // Drizzle оборачивает ошибку базы в свою, с текстом запроса и значениями параметров.
      // Сервисам нужна ошибка базы (код, имя ограничения), а значения параметров
      // не должны попадать в журнал: в них данные клиентов.
      if (error instanceof DrizzleQueryError && error.cause) throw error.cause;
      throw error;
    } finally {
      if (startedAt !== null) noteSlowTx(actor, startedAt);
    }
  };
}

export const withActor: WithActor = (actor, fn) => createWithActor(getAppDb())(actor, fn);
