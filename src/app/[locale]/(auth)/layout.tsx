import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getPolicyVersion } from '@/modules/hdc/api';
import { AuthShell } from '@/ui/shell/AuthShell';

// Страницы без входа: вход клиента и сотрудника, принятие приглашения, одноразовые ссылки.
// Внизу ссылка на политику обработки данных, когда она утверждена (раздел 14.6 ТЗ, решение 0017).
export default async function AuthLayout({ children }: LayoutProps<'/[locale]'>) {
  const t = await getTranslations('common.legal');
  const policy = await getPolicyVersion();
  return (
    <AuthShell
      footer={
        policy && (
          <Link href="/legal/privacy" className="font-medium text-link underline-offset-4 hover:underline">
            {t('privacy')}
          </Link>
        )
      }
    >
      {children}
    </AuthShell>
  );
}
