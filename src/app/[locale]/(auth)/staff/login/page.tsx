import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { currentStaff, safeReturnPath } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { StaffLoginForm } from './StaffLoginForm';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Вход сотрудников Smartup: пароль и код второго фактора (FR-ID-09).
export default async function StaffLoginPage({ searchParams }: PageProps<'/[locale]/staff/login'>) {
  const params = await searchParams;
  const locale = await getLocale();
  const next = safeReturnPath(first(params.next), `/${locale}/agent`);
  const reauth = first(params.reauth) === '1';
  // Вошедшему сотруднику форма не нужна, кроме случая, когда действие просит войти ещё раз.
  if (!reauth && (await currentStaff())) redirect(next);

  const t = await getTranslations('auth.staff.login');
  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {first(params.setup) === '1' && <Alert tone="success">{t('setupDone')}</Alert>}
        {reauth && <Alert tone="info">{t('reauth')}</Alert>}
        <StaffLoginForm
          next={next}
          labels={{
            email: t('email'),
            password: t('password'),
            submit: t('submit'),
            codeLabel: t('codeLabel'),
            codeHint: t('codeHint'),
            codeSubmit: t('codeSubmit'),
            enrollTitle: t('enrollTitle'),
            enrollText: t('enrollText'),
            qrLabel: t('qrLabel'),
            secretLabel: t('secretLabel'),
            startOver: t('startOver'),
          }}
        />
      </CardContent>
    </Card>
  );
}
