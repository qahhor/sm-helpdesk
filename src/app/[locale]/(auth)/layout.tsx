import { AuthShell } from '@/ui/shell/AuthShell';

// Страницы без входа: вход клиента и сотрудника, принятие приглашения, одноразовые ссылки.
export default function AuthLayout({ children }: LayoutProps<'/[locale]'>) {
  return <AuthShell>{children}</AuthShell>;
}
