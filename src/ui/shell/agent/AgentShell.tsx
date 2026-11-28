import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { StaffRole } from '@/modules/hdu/pref';
import { AgentHotkeys } from '@/ui/agent/AgentHotkeys';
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
  bell,
  role = null,
}: {
  children: ReactNode;
  userMenu?: ReactNode;
  /** Колокольчик уведомлений (веха M4): у витрины компонентов его нет. */
  bell?: ReactNode;
  /** Роль сотрудника: от неё зависят пункты панели. У витрины компонентов роли нет. */
  role?: StaffRole | null;
}) {
  const t = await getTranslations('common');
  const ta = await getTranslations('agent');
  const writer = role !== null && role !== 'product';
  // Разделы для палитры команд (UX-A-02): только существующие экраны и только доступные роли.
  const sections = role
    ? [
        { label: ta('queues.title'), href: '/agent/queues' },
        { label: ta('queues.names.mine'), href: '/agent/queues?queue=mine' },
        { label: ta('queues.names.new'), href: '/agent/queues?queue=new' },
        { label: ta('queues.thanks.title'), href: '/agent/queues/thanks' },
        { label: ta('playbooks.title'), href: '/agent/playbooks' },
        ...(writer ? [{ label: ta('newTicket.title'), href: '/agent/tickets/new' }] : []),
        ...(role === 'admin' ? [{ label: ta('settings.title'), href: '/agent/settings' }] : []),
      ]
    : [];
  const actionKeys = ['palette.open', 'help.open', 'reply.focus', 'note.focus', 'form.complete', 'reply.sendNext', 'ticket.take', 'ticket.snooze', 'list.next', 'list.prev', 'table.refresh'];
  return (
    <AgentRoot>
      <a
        href="#main"
        className="sr-only z-50 rounded-control bg-card px-4 py-3 font-semibold text-link focus:not-sr-only focus:fixed focus:start-2 focus:top-2"
      >
        {t('skipToContent')}
      </a>
      <TopBar userMenu={userMenu} bell={bell} role={role} />
      {role && (
        <AgentHotkeys
          locale={await getLocale()}
          sections={sections}
          labels={{
            title: ta('keys.palette.title'),
            search: ta('keys.palette.search'),
            empty: ta('keys.palette.empty'),
            close: ta('keys.palette.close'),
            list: ta('keys.palette.list'),
            openTicket: ta.raw('keys.palette.openTicket') as string,
            sectionsGroup: ta('keys.palette.sections'),
            helpTitle: ta('keys.help.title'),
            keyNames: { ArrowDown: ta('keys.names.ArrowDown'), ArrowUp: ta('keys.names.ArrowUp') },
            actions: Object.fromEntries(actionKeys.map((key) => [key, ta(`keys.actions.${key.replace('.', '_')}`)])),
          }}
        />
      )}
      <main id="main" className="mx-auto flex w-full max-w-dashboard flex-1 flex-col gap-4 px-4 py-4 laptop:px-6">
        {children}
      </main>
    </AgentRoot>
  );
}
