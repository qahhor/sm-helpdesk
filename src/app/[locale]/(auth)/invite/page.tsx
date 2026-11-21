import { getLocale, getTranslations } from 'next-intl/server';
import { describeInvitation } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { FormField } from '@/ui/components/form-field';
import { acceptInvitationAction } from './actions';
import { firstParam } from '@/lib/search-params';

// Страница приглашения из письма. Открытие ничего не меняет (почтовый сканер ссылку не тратит),
// принимает только нажатие кнопки (решение 0016). Имя спрашивается, если учётной записи ещё нет.
// Существующая учётная запись принимает приглашение, только войдя в неё (проверка main, S3).
export default async function InvitePage({ searchParams }: PageProps<'/[locale]/invite'>) {
  const params = await searchParams;
  const t = await getTranslations('auth.invite');
  const token = firstParam(params.token);
  const error = firstParam(params.error);
  const invitation = token && (!error || error === 'sign_in_required') ? await describeInvitation(token) : null;
  const locale = await getLocale();

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
      <CardContent className="flex flex-col gap-4">
        {!invitation.needsName && <p className="text-sm text-secondary-foreground">{t('existingAccount')}</p>}
        {error === 'sign_in_required' && (
          <>
            <Alert tone="info">{t('signInRequired', { email: invitation.email })}</Alert>
            <a href={`/${locale}/login?next=${encodeURIComponent(`/${locale}/invite?token=${token}`)}`} className={buttonVariants()}>
              {t('signIn')}
            </a>
          </>
        )}
        <form action={acceptInvitationAction} className="flex flex-col gap-4">
          <input type="hidden" name="token" value={token} />
          {invitation.needsName && <FormField name="name" label={t('name')} autoComplete="name" maxLength={120} required />}
          <Button type="submit">{t('submit')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
