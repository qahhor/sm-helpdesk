import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/audit';
import { authUser } from '../auth-schema';
import type { ClientRole } from '../pref';
import { memberships, organizations, servers } from '../schema';
import { syntheticEmail } from '../util';
import { smartupProfile } from './claims';

// Первый и каждый следующий вход через Smartup (ТЗ 11.3, FR-ID-04, решение 93 ТЗ, решение 0013).
//
// Личность пользователя задаёт пара "сервер Smartup и идентификатор пользователя на нём" (sub).
// По email пользователь не ищется никогда: одинаковый адрес у двух людей не объединяет их учётные записи.

/** Минимум адаптера базы библиотеки входа: его транзакция, в которой создаётся вход. */
export type LibraryDb = {
  findOne<T>(data: { model: string; where: { field: string; value: string }[] }): Promise<T | null>;
  create<T extends Record<string, unknown>, R = T>(data: { model: string; data: Omit<T, 'id'> }): Promise<R>;
};

const cleanName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, 200);
  return name.length > 0 ? name : null;
};

/**
 * Какой пользователь портала входит. Есть способ входа с этой парой "сервер и sub": его пользователь.
 * Нет: новый пользователь со служебным адресом и неподтверждённым email.
 *
 * Работает в транзакции библиотеки входа: если вход сорвётся дальше, пользователь не останется
 * без способа входа, а два одновременных первых входа одного человека не создадут двух пользователей.
 */
export async function resolveSmartupUser(
  input: { providerId: string; accountId: string; name?: unknown },
  db: LibraryDb,
): Promise<{ userId: string; created: boolean }> {
  const existing = await db.findOne<{ userId: string }>({
    model: 'account',
    where: [
      { field: 'providerId', value: input.providerId },
      { field: 'accountId', value: input.accountId },
    ],
  });
  if (existing) return { userId: existing.userId, created: false };
  const now = new Date();
  const user = await db.create<Record<string, unknown>, { id: string }>({
    model: 'user',
    data: { name: cleanName(input.name) ?? 'Smartup', email: syntheticEmail(), emailVerified: false, createdAt: now, updatedAt: now },
  });
  return { userId: user.id, created: true };
}

const SYSTEM = { type: 'system', job: 'identity.provision' } as const;

/** Что известно о входе, без личных данных: для журнала приложения. */
function logFailure(reason: string, serverCode: string): void {
  console.warn(`Вход через Smartup без организации: причина ${reason}, сервер ${serverCode.slice(0, 31)}`);
}

/**
 * Организация и членство по сведениям из Smartup. Вызывается при каждом входе, после того как
 * библиотека входа создала сессию. Ошибок наружу не бросает: сбой здесь не должен ломать вход,
 * человек без членства попадёт на экран "нет организации".
 */
export async function provisionFromSmartup(
  userId: string,
  serverCode: string,
  raw: unknown,
): Promise<{ orgId: string } | { failed: 'no_company' | 'invalid_claims' }> {
  if (raw === null || typeof raw !== 'object') {
    logFailure('invalid_claims', serverCode);
    return { failed: 'invalid_claims' };
  }
  const parsed = smartupProfile.safeParse(raw);
  if (!parsed.success) {
    const source = raw as Record<string, unknown>;
    const noCompany = [source.companyId, source.companyName].some((value) => value === undefined || value === null || value === '');
    const reason = noCompany ? 'no_company' : 'invalid_claims';
    logFailure(reason, serverCode);
    return { failed: reason };
  }
  const profile = parsed.data;
  try {
    return await withIdentity(SYSTEM, async (tx) => {
      const server = (
        await tx.select({ serverId: servers.serverId, roleMap: servers.roleMap }).from(servers).where(eq(servers.code, serverCode)).limit(1)
      )[0];
      if (!server) {
        logFailure('unknown_server', serverCode);
        return { failed: 'invalid_claims' as const };
      }

      // Организация: пара "сервер и идентификатор компании". Название и ИНН обновляются при каждом входе,
      // пустой ИНН известное значение не стирает.
      const org = (
        await tx
          .insert(organizations)
          .values({ serverId: server.serverId, externalCompanyId: profile.companyId, name: profile.companyName, inn: profile.inn ?? null })
          .onConflictDoUpdate({
            target: [organizations.serverId, organizations.externalCompanyId],
            set: { name: profile.companyName, inn: sql`coalesce(excluded.inn, ${organizations.inn})` },
          })
          .returning({ orgId: organizations.orgId, inserted: sql<boolean>`xmax = 0` })
      )[0] as { orgId: string; inserted: boolean };
      if (org.inserted) await writeAudit(tx, { action: 'org.provisioned', objectType: 'organization', objectId: org.orgId, orgId: org.orgId });

      // Членство. Роль по соответствию ролей сервера, иначе обычный пользователь.
      // Роль, выданная сотрудником вручную, не меняется. Отключённое членство вход не включает.
      const mappedRole: ClientRole = (profile.role && server.roleMap[profile.role]) || 'client_user';
      const current = (
        await tx
          .select({ role: memberships.role, isRoleManual: memberships.isRoleManual })
          .from(memberships)
          .where(and(eq(memberships.orgId, org.orgId), eq(memberships.userId, userId)))
          .limit(1)
          .for('update')
      )[0];
      if (!current) {
        await tx.insert(memberships).values({ orgId: org.orgId, userId, role: mappedRole, source: 'smartup' });
        await writeAudit(tx, { action: 'member.joined', objectType: 'membership', objectId: userId, orgId: org.orgId, diff: { role: mappedRole, source: 'smartup' } });
      } else if (!current.isRoleManual && current.role !== mappedRole) {
        await tx
          .update(memberships)
          .set({ role: mappedRole })
          .where(and(eq(memberships.orgId, org.orgId), eq(memberships.userId, userId)));
        await writeAudit(tx, {
          action: 'member.role_changed',
          objectType: 'membership',
          objectId: userId,
          orgId: org.orgId,
          diff: { from: current.role, to: mappedRole, source: 'smartup' },
        });
      }

      // Имя из Smartup, последняя организация. Адрес из Smartup запоминается, пока нет подтверждённого:
      // для входа он не используется, только подставляется на шаге первого входа.
      await tx
        .update(authUser)
        .set({
          name: profile.name,
          lastOrgId: org.orgId,
          claimedEmail: sql`case when ${authUser.emailVerified} then null else coalesce(${profile.contactEmail ?? null}::text, ${authUser.claimedEmail}) end`,
          updatedAt: new Date(),
        })
        .where(eq(authUser.id, userId));
      return { orgId: org.orgId };
    });
  } catch (error) {
    logFailure(error instanceof Error ? error.name : 'error', serverCode);
    return { failed: 'invalid_claims' };
  }
}
