import 'server-only';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { type AppDb, getAppDb, type Tx } from './client';

// Весь доступ к данным идёт через withActor (ТЗ, раздел 11.1). Функция открывает транзакцию
// и сообщает базе, от чьего имени выполняется запрос. Значения живут до конца транзакции,
// поэтому приём безопасен при пуле соединений.
//
// Актор строится только из проверенной сессии или проверенного токена виджета.
// Ни одно его поле не берётся из тела запроса, адреса или заголовков.

export type ClientActor = {
  type: 'client';
  userId: string;
  orgId: string;
  orgRole: 'client_user' | 'client_admin';
};
export type StaffActor = {
  type: 'staff';
  userId: string;
  staffRole: 'agent_l1' | 'agent_l2' | 'care' | 'product' | 'admin';
};
export type SystemActor = { type: 'system'; job: string };
/** AI-сотрудник, который работает через сервер MCP. */
export type AgentActor = { type: 'agent'; tokenId: string; tools: string[] };
export type Actor = ClientActor | StaffActor | SystemActor | AgentActor;

export type WithActor = <T>(actor: Actor, fn: (tx: Tx) => Promise<T>) => Promise<T>;

export function createWithActor(db: AppDb): WithActor {
  return async (actor, fn) => {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`
          select set_config('app.actor_type', ${actor.type}, true),
                 set_config('app.user_id', ${'userId' in actor ? actor.userId : ''}, true),
                 set_config('app.org_id', ${actor.type === 'client' ? actor.orgId : ''}, true),
                 set_config('app.org_role', ${actor.type === 'client' ? actor.orgRole : ''}, true),
                 set_config('app.staff_role', ${actor.type === 'staff' ? actor.staffRole : ''}, true)`);
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
