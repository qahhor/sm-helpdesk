import type { StaffActor } from '@/db/with-actor';

// Модуль hdc: контекст сотрудника и свежесть входа. Объявлены здесь, а не в модуле пользователей: их принимают
// точки входа всех модулей, в том числе тех, что стоят ниже hdu (уведомления, правила). Строит контекст по сессии
// модуль пользователей (hdu/api/session.ts).

export type StaffContext = {
  actor: StaffActor;
  user: { id: string; name: string; email: string };
  /** Руководитель своей линии. Прав на данные сверх роли не даёт. */
  isLead: boolean;
  /**
   * Когда сотрудник подтвердил личность в этой сессии (пароль с кодом второго фактора): по этому времени
   * считается свежий вход (решение 0083). Пусто: личность в сессии не подтверждалась.
   */
  freshAuthAt: Date | null;
};

/** Вход свежий: личность подтверждена не более maxAgeSec секунд назад (ТЗ 14.3, решения 0014 и 0083). */
export function isFresh(ctx: StaffContext, now: Date, maxAgeSec: number): boolean {
  return ctx.freshAuthAt !== null && now.getTime() - ctx.freshAuthAt.getTime() <= maxAgeSec * 1000;
}

/** Срок свежего входа для действий администратора: 15 минут. */
export const FRESH_SIGN_IN_SEC = 15 * 60;
