import { AuthShell } from '@/ui/shell/AuthShell';

// Экраны между входом и кабинетом: выбор организации, "нет организации".
// Человек уже вошёл, но актора клиента у него ещё нет. Каждая страница сама вызывает requireSignedInClient.
export default function GateLayout({ children }: LayoutProps<'/[locale]'>) {
  return <AuthShell>{children}</AuthShell>;
}
