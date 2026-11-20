import 'server-only';
import type { StaffActor } from '@/db/with-actor';
import { revokeSessionById } from '../core/sessions';
import { findStaff } from '../core/staff';
import { STAFF_SESSION_TTL_SEC } from '../pref';
import type { SessionData } from './request';

// Кто перед нами: построение актора из проверенной сессии (ТЗ 11.1).
// Функции этого файла не зависят от Next.js: их вызывают и страницы (через api/actor.ts), и тесты.

export type StaffContext = {
  actor: StaffActor;
  user: { id: string; name: string; email: string };
  /** Руководитель своей линии. Прав на данные сверх роли не даёт. */
  isLead: boolean;
  /** Когда сотрудник вошёл: по этому времени считается свежий вход. */
  sessionCreatedAt: Date;
};

export type StaffDenial = { denied: 'no_session' | 'not_staff' | 'no_second_factor' | 'expired' };

/**
 * Актор сотрудника по сессии. Допуск получает только действующий сотрудник с подключённым
 * вторым фактором, вошедший не более 12 часов назад (FR-ID-09, FR-ID-10).
 */
export async function resolveStaff(session: SessionData | null, now: Date): Promise<StaffContext | StaffDenial> {
  if (!session) return { denied: 'no_session' };
  const staff = await findStaff(session.user.id);
  if (!staff || staff.state !== 'active' || staff.role === 'agent_bot') return { denied: 'not_staff' };
  // Сессия после одного пароля годится только для подключения второго фактора.
  if (!session.user.twoFactorEnabled) return { denied: 'no_second_factor' };
  if (now.getTime() - session.session.createdAt.getTime() > STAFF_SESSION_TTL_SEC * 1000) {
    await revokeSessionById(session.session.id);
    return { denied: 'expired' };
  }
  return {
    actor: { type: 'staff', userId: session.user.id, staffRole: staff.role },
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    isLead: staff.isLead,
    sessionCreatedAt: session.session.createdAt,
  };
}

/** Вход свежий: сессия создана не более maxAgeSec секунд назад (ТЗ 14.3, решение 0014). */
export function isFresh(ctx: StaffContext, now: Date, maxAgeSec: number): boolean {
  return now.getTime() - ctx.sessionCreatedAt.getTime() <= maxAgeSec * 1000;
}

/** Срок свежего входа для действий администратора: 15 минут. */
export const FRESH_SIGN_IN_SEC = 15 * 60;
