import { getTranslations } from 'next-intl/server';
import { describeStaffInvitation } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { StaffSetupForm } from './StaffSetupForm';
import { firstParam } from '@/lib/search-params';

// Сотрудник открывает ссылку приглашения и задаёт пароль. Открытие страницы приглашение не тратит:
// его принимает только отправка формы.
export default async function StaffSetupPage({ searchParams }: PageProps<'/[locale]/staff/setup'>) {
  const token = firstParam((await searchParams).token) ?? '';
  const invitation = await describeStaffInvitation(token);
  const t = await getTranslations('auth.staff.setup');

  if (!invitation)
    return (
      <Card>
        <CardHeader>
          <h1 className="text-xl font-semibold">{t('invalidTitle')}</h1>
        </CardHeader>
        <CardContent>
          <Alert tone="danger">{t('invalidText')}</Alert>
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-secondary-foreground">{t('text', { email: invitation.email })}</p>
      </CardHeader>
      <CardContent>
        <StaffSetupForm
          token={token}
          email={invitation.email}
          name={invitation.name ?? ''}
          labels={{
            name: t('name'),
            password: t('password'),
            passwordHint: t('passwordHint'),
            passwordRepeat: t('passwordRepeat'),
            submit: t('submit'),
          }}
        />
      </CardContent>
    </Card>
  );
}
