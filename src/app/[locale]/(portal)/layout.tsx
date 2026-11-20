import { ClientShell } from '@/ui/shell/client/ClientShell';

// Все страницы кабинета клиента идут в общей оболочке.
export default function PortalLayout({ children }: LayoutProps<'/[locale]'>) {
  return <ClientShell>{children}</ClientShell>;
}
