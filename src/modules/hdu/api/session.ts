import 'server-only';
import { FRESH_SIGN_IN_SEC, type StaffContext } from '@/modules/hdc/api';
import { markSessionActive, revokeSessionById } from '../core/sessions';
import { findStaff } from '../core/staff';
import { logEvent } from '@/lib/log';
import { STAFF_ACTIVITY_STEP_SEC, STAFF_IDLE_SEC, STAFF_SESSION_TTL_SEC, type StaffRole } from '../pref';
import type { SessionData } from './request';

// Кто перед нами: построение актора из проверенной сессии (ТЗ 11.1).
// Функции этого файла не зависят от Next.js: их вызывают и страницы (через api/actor.ts), и тесты.

// Контекст сотрудника и свежесть входа объявлены в общем модуле: их принимают и модули ниже hdu.
export { FRESH_SIGN_IN_SEC, isFresh, type StaffContext } from '@/modules/hdc/api';

/**
 * Вход недавний: личность подтверждена в этой сессии не раньше того же окна, что у настроек сотрудников
 * (FRESH_SIGN_IN_SEC, 15 минут). Им проверяются смена адреса и завершение сессий клиентом (ASVS 7.5, решение 0067).
 * Время берётся из freshAuthAt, а не из создания сессии (решение 0083): обычный вход через Smartup его не ставит.
 */
export function isRecentSignIn(freshAuthAt: Date | null, now: Date): boolean {
  return freshAuthAt !== null && now.getTime() - freshAuthAt.getTime() <= FRESH_SIGN_IN_SEC * 1000;
}

export type StaffDenial = { denied: 'no_session' | 'not_staff' | 'no_second_factor' | 'expired' | 'idle' };

/**
 * Допуск к рабочему месту по результату resolveStaff: ok, страница входа или 404. Отказ не сотруднику и сотруднику без
 * нужной роли пишется в журнал процесса событием authz.denied (ASVS 5.0.0, требование 16.3.2): идентификатор и роль,
 * без имени, адреса и пути страницы. Нет входа, второго фактора или сессия истекла: это вход, а не отказ.
 */
export function staffAccess(result: StaffContext | StaffDenial, roles?: readonly StaffRole[], userId?: string): 'ok' | 'sign_in' | 'not_found' {
  if ('denied' in result) {
    if (result.denied !== 'not_staff') return 'sign_in';
    logEvent('warn', 'authz.denied', { area: 'agent', reason: 'not_staff', userId });
    return 'not_found';
  }
  if (roles && !roles.includes(result.actor.staffRole)) {
    logEvent('warn', 'authz.denied', { area: 'agent', reason: 'role', userId: result.actor.userId, role: result.actor.staffRole, need: roles.join(',') });
    return 'not_found';
  }
  return 'ok';
}

/** Последнее действие человека в сессии сотрудника: отметка активности, иначе вход с кодом второго фактора. */
const lastActiveOf = (session: SessionData): Date => session.session.staffActiveAt ?? session.session.secondFactorAt ?? session.session.createdAt;

/**
 * Актор сотрудника по сессии. Допуск получает только действующий сотрудник с подключённым
 * вторым фактором, вошедший не более 12 часов назад (FR-ID-09, FR-ID-10) и действовавший не позже 30 минут назад
 * (план M9, решение 8). Проверка срока сама срок не продлевает: продлевает только markStaffActivity. Истёкшая и
 * простоявшая сессия завершается, вход ведёт обратно на ту же страницу.
 */
export async function resolveStaff(session: SessionData | null, now: Date): Promise<StaffContext | StaffDenial> {
  if (!session) return { denied: 'no_session' };
  const staff = await findStaff(session.user.id);
  if (!staff || staff.state !== 'active' || staff.role === 'agent_bot') return { denied: 'not_staff' };
  // Сессия после одного пароля годится только для подключения второго фактора. Проверяется сама сессия:
  // признак учётной записи появляется и у сессии, открытой паролем до подключения в другом браузере.
  if (!session.user.twoFactorEnabled || !session.session.secondFactorAt) return { denied: 'no_second_factor' };
  if (now.getTime() - session.session.createdAt.getTime() > STAFF_SESSION_TTL_SEC * 1000) {
    await revokeSessionById(session.session.id);
    return { denied: 'expired' };
  }
  if (now.getTime() - lastActiveOf(session).getTime() > STAFF_IDLE_SEC * 1000) {
    await revokeSessionById(session.session.id);
    return { denied: 'idle' };
  }
  return {
    actor: { type: 'staff', userId: session.user.id, staffRole: staff.role },
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    isLead: staff.isLead,
    freshAuthAt: session.session.freshAuthAt,
  };
}



/**
 * Отметка действия человека в рабочем месте (план M9, решение 8): её шлёт страница при открытии и при вводе, не
 * фоновые запросы. Только для действующей сессии сотрудника, не простоявшей 30 минут: простоявшую отметка не
 * возвращает. В базу пишется не чаще раза в минуту. Возвращает, действует ли сессия.
 */
export async function markStaffActivity(session: SessionData | null, now: Date): Promise<boolean> {
  if (!session) return false;
  const result = await resolveStaff(session, now);
  if ('denied' in result) return false;
  if (now.getTime() - lastActiveOf(session).getTime() >= STAFF_ACTIVITY_STEP_SEC * 1000) await markSessionActive(session.session.id, now);
  return true;
}
