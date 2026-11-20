import { AuthShell } from '@/ui/shell/AuthShell';

// Открытые страницы: политика обработки данных и другие тексты для всех. Сессию не читают,
// в базу не ходят (правило линтера для группы (public), CLAUDE.md).
export default function PublicLayout({ children }: LayoutProps<'/[locale]'>) {
  return <AuthShell wide>{children}</AuthShell>;
}
