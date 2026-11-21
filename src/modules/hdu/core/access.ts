import 'server-only';
import { and, eq, ne, type SQL, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { memberships, organizations, servers, staff } from '../schema';

// Модуль hdu, слой core: одно общее условие "какое членство даёт вход клиента" (проверка main, S4 и Q3).
// Его используют выбор организации (актор клиента), ссылка для входа на email и вход из бота Telegram:
// новый способ входа или новый вид членства меняет правило в одном месте.
//
// Членство даёт вход, если:
// - членство действующее и не гостевое (гости появятся в M4 с приёмом почты, решение 0017);
// - организация действующая;
// - сервер Smartup этой организации действующий: отключённый сервер закрывает доступ его клиентам
//   всеми путями, а не только новый вход через Smartup (ТЗ 14.7);
// - пользователь не сотрудник (сотрудник не получает актора клиента).

/** Условие для запроса, в котором есть memberships, organizations и servers (см. signInMemberships). */
export const signInMembership: SQL = and(
  eq(memberships.state, 'active'),
  ne(memberships.source, 'guest'),
  eq(organizations.state, 'active'),
  eq(servers.state, 'active'),
  sql`not exists (select 1 from ${staff} where ${staff.userId} = ${memberships.userId})`,
) as SQL;

/** Членства, которые дают вход клиента, с организацией. where добавляет свои условия. */
export function signInMemberships(tx: Tx, where?: SQL) {
  return tx
    .select({ orgId: organizations.orgId, name: organizations.name, role: memberships.role, userId: memberships.userId })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.orgId, memberships.orgId))
    .innerJoin(servers, eq(servers.serverId, organizations.serverId))
    .where(where ? and(signInMembership, where) : signInMembership);
}
