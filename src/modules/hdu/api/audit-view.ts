import 'server-only';
import { type AuditRow, listAudit } from '@/modules/hdc/api';
import { namesOf } from '../core/members';
import { orgSummariesTx } from '../core/staff-lookup';
import { uuidInput } from '../input';
import type { StaffContext } from './session';

// Модуль hdu, слой api: журнал аудита с именами (FR-ADM-07). Строки журнала читает общий модуль, имена авторов
// и организаций добавляет этот модуль: таблицы людей и организаций принадлежат ему (аудит 23.11.2026, находка A2).
// Раньше общий модуль читал их подзапросами прямо из чужих таблиц.

export type NamedAuditRow = AuditRow & {
  /** Имя автора действия. У системы и у удалённого пользователя пусто. */
  actorName: string | null;
  orgName: string | null;
};

/** Страница журнала аудита с именами авторов и организаций. Права и проверку входа держит listAudit. */
export async function listAuditNamed(ctx: StaffContext, input: unknown): Promise<{ items: NamedAuditRow[]; nextCursor: string | null }> {
  const page = await listAudit(ctx, input);
  const ids = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null && uuidInput.safeParse(value).success))];
  const actorIds = ids(page.items.map((row) => row.actorId));
  const orgIds = ids(page.items.map((row) => row.orgId));
  const [names, orgs] = await Promise.all([
    actorIds.length > 0 ? namesOf(ctx.actor, actorIds) : new Map<string, string>(),
    orgIds.length > 0 ? orgSummariesTx(ctx.actor, orgIds) : new Map<string, { name: string }>(),
  ]);
  return {
    items: page.items.map((row) => ({
      ...row,
      actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
      orgName: row.orgId ? (orgs.get(row.orgId)?.name ?? null) : null,
    })),
    nextCursor: page.nextCursor,
  };
}
