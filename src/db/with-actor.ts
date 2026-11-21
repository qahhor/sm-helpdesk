import 'server-only';
import { isIP } from 'node:net';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { type AppDb, getAppDb, type Tx } from './client';

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
/** AI-сотрудник, который работает через сервер MCP. */
export type AgentActor = { type: 'agent'; tokenId: string; tools: string[] };
export type Actor = ClientActor | StaffActor | SystemActor | AgentActor;

export type WithActor = <T>(actor: Actor, fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** Транзакция от имени актора на заданном подключении. Её же использует withIdentity (подключение hub_auth). */
export function createWithActor(db: AppDb): WithActor {
  return async (actor, fn) => {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`
          select set_config('app.actor_type', ${actor.type}, true),
                 set_config('app.user_id', ${'userId' in actor ? actor.userId : ''}, true),
                 set_config('app.org_id', ${actor.type === 'client' ? actor.orgId : ''}, true),
                 set_config('app.org_role', ${actor.type === 'client' ? actor.orgRole : ''}, true),
                 set_config('app.staff_role', ${actor.type === 'staff' ? actor.staffRole : ''}, true),
                 set_config('app.client_ip', ${'ip' in actor && actor.ip && isIP(actor.ip) !== 0 ? actor.ip : ''}, true)`);
        return fn(tx);
      });
    } catch (error) {
      // Drizzle оборачивает ошибку базы в свою, с текстом запроса и значениями параметров.
      // Сервисам нужна ошибка базы (код, имя ограничения), а значения параметров
      // не должны попадать в журнал: в них данные клиентов.
      if (error instanceof DrizzleQueryError && error.cause) throw error.cause;
      throw error;
    }
  };
}

export const withActor: WithActor = (actor, fn) => createWithActor(getAppDb())(actor, fn);
