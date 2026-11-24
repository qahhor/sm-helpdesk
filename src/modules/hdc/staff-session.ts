import type { StaffActor } from '@/db/with-actor';

// Модуль hdc: контекст сотрудника и свежесть входа. Объявлены здесь, а не в модуле пользователей: их принимают
// точки входа всех модулей, в том числе тех, что стоят ниже hdu (уведомления, правила). Строит контекст по сессии
// модуль пользователей (hdu/api/session.ts).

export type StaffContext = {
  actor: StaffActor;
  user: { id: string; name: string; email: string };
  /** Руководитель своей линии. Прав на данные сверх роли не даёт. */
  isLead: boolean;
  /** Когда сотрудник вошёл: по этому времени считается свежий вход. */
  sessionCreatedAt: Date;
};

/** Вход свежий: сессия создана не более maxAgeSec секунд назад (ТЗ 14.3, решение 0014). */
export function isFresh(ctx: StaffContext, now: Date, maxAgeSec: number): boolean {
  return now.getTime() - ctx.sessionCreatedAt.getTime() <= maxAgeSec * 1000;
}

/** Срок свежего входа для действий администратора: 15 минут. */
export const FRESH_SIGN_IN_SEC = 15 * 60;
