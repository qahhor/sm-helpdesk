import { getTranslations } from 'next-intl/server';
import { describeInvitation } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { FormField } from '@/ui/components/form-field';
import { acceptInvitationAction } from './actions';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Страница приглашения из письма. Открытие ничего не меняет (почтовый сканер ссылку не тратит),
// принимает только нажатие кнопки (решение 0016). Имя спрашивается, если учётной записи ещё нет.
export default async function InvitePage({ searchParams }: PageProps<'/[locale]/invite'>) {
  const params = await searchParams;
  const t = await getTranslations('auth.invite');
  const token = first(params.token);
  const error = first(params.error);
  const invitation = token && !error ? await describeInvitation(token) : null;

  if (!invitation)
    return (
      <Card>
        <CardHeader>
          <h1 className="text-xl font-semibold">{t('invalidTitle')}</h1>
        </CardHeader>
        <CardContent>
          <Alert tone="danger">{t(error === 'email_taken' ? 'taken' : 'invalid')}</Alert>
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold wrap-anywhere">{t('title', { orgName: invitation.orgName })}</h1>
        <p className="text-secondary-foreground wrap-anywhere">{t('text', { email: invitation.email })}</p>
      </CardHeader>
      <CardContent>
        <form action={acceptInvitationAction} className="flex flex-col gap-4">
          <input type="hidden" name="token" value={token} />
          {invitation.needsName && <FormField name="name" label={t('name')} autoComplete="name" maxLength={120} required />}
          <Button type="submit">{t('submit')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
