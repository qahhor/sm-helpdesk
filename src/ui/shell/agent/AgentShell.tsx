import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { StaffRole } from '@/modules/hdu/pref';
import { AgentRoot } from './AgentRoot';
import { TopBar } from './TopBar';

/**
 * Оболочка рабочего места сотрудника. Плотная раскладка для ноутбука: текст 14 px, строка 48 px.
 * Доступ проверяет раскладка (agent) и каждая страница (requireStaffActor). Меню пользователя
 * приходит готовым от раскладки: у витрины компонентов его нет.
 */
export async function AgentShell({
  children,
  userMenu,
  role = null,
}: {
  children: ReactNode;
  userMenu?: ReactNode;
  /** Роль сотрудника: от неё зависят пункты панели. У витрины компонентов роли нет. */
  role?: StaffRole | null;
}) {
  const t = await getTranslations('common');
  return (
    <AgentRoot>
      <a
        href="#main"
        className="sr-only z-50 rounded-control bg-card px-4 py-3 font-semibold text-link focus:not-sr-only focus:fixed focus:start-2 focus:top-2"
      >
        {t('skipToContent')}
      </a>
      <TopBar userMenu={userMenu} role={role} />
      <main id="main" className="mx-auto flex w-full max-w-dashboard flex-1 flex-col gap-4 px-4 py-4 laptop:px-6">
        {children}
      </main>
    </AgentRoot>
  );
}
