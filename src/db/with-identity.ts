import 'server-only';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { getAuthDb } from './auth-client';
import type { AppDb } from './client';
import type { WithActor } from './with-actor';

// Транзакция под ролью hub_auth от имени актора. Механика та же, что у withActor:
// база узнаёт, кто выполняет запрос, из переменных транзакции, и политики RLS таблиц идентичности
// на них опираются. Так правило "права проверяются дважды" (ТЗ 9.4) действует и там,
// где данные меняет модуль идентичности: приглашения, роли, сотрудники, реестр серверов.
//
// Актор строится только из проверенной сессии. Действия без пользователя (первый вход через Smartup,
// принятие приглашения, команда консоли) выполняет актор system с названием задачи.

export function createWithIdentity(db: AppDb): WithActor {
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
      // Сервису нужна ошибка базы (код, имя ограничения). Обёртка Drizzle несёт значения параметров:
      // в журнал они попадать не должны.
      if (error instanceof DrizzleQueryError && error.cause) throw error.cause;
      throw error;
    }
  };
}

export const withIdentity: WithActor = (actor, fn) => createWithIdentity(getAuthDb())(actor, fn);
