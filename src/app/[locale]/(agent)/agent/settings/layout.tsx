import { requireStaffActor } from '@/modules/hdu/api';

// Раздел "Настройки" только для администратора портала. Остальным сотрудникам 404 (решение 0019).
// Проверка здесь, а не только на страницах: иначе файл loading.tsx отдал бы ответ 200 раньше страницы.
// Каждая страница всё равно проверяет роль сама: раскладка при переходах не перерисовывается.
export default async function SettingsSectionLayout({ children }: LayoutProps<'/[locale]/agent/settings'>) {
  await requireStaffActor({ roles: ['admin'] });
  return children;
}
