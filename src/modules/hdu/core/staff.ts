import 'server-only';
import { eq } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import type { RecordState, StaffRole } from '../pref';
import { staff } from '../schema';

// Модуль hdu, слой core: сотрудники. Операции с данными под ролью hub_auth.

const SYSTEM = { type: 'system', job: 'identity.staff' } as const;

export type StaffInfo = { role: StaffRole; state: RecordState; isLead: boolean };

/** Строка сотрудника по идентификатору пользователя. Пусто, если пользователь не сотрудник. */
export async function findStaff(userId: string): Promise<StaffInfo | null> {
  const rows = await withIdentity(SYSTEM, (tx) =>
    tx
      .select({ role: staff.role, state: staff.state, isLead: staff.isLead })
      .from(staff)
      .where(eq(staff.userId, userId))
      .limit(1),
  );
  return rows[0] ?? null;
}
