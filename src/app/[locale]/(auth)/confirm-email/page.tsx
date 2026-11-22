import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { currentClientName } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { confirmEmailAction } from './actions';
import { firstParam } from '@/lib/search-params';

// Подтверждение адреса по ссылке из письма (FR-ID-07). Как и у ссылки для входа,
// открытие страницы ничего не меняет: подтверждает только нажатие кнопки, и только вошедший владелец
// запроса (проверка main, S2). Страница называет учётную запись, к которой привяжется адрес.
export default async function ConfirmEmailPage({ searchParams }: PageProps<'/[locale]/confirm-email'>) {
  const params = await searchParams;
  const t = await getTranslations('auth.confirmEmail');
  const token = firstParam(params.token);
  const error = firstParam(params.error);
  const done = firstParam(params.done) === '1';
  const locale = await getLocale();
  const name = await currentClientName();
  const back = token ? `/${locale}/confirm-email?token=${encodeURIComponent(token)}` : `/${locale}/settings`;
  // Без входа подтверждать некому: сразу предлагается войти и вернуться по этой же ссылке.
  const needsSignIn = Boolean(token) && !done && !name && (!error || error === 'sign_in_required');
  const tooOften = error === 'rate_limited';
  const canConfirm = Boolean(token) && !done && (!error || tooOften) && Boolean(name);
  const tAuth = await getTranslations('auth');

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {canConfirm && <p className="text-secondary-foreground">{t('text')}</p>}
        {canConfirm && name && <p className="text-sm text-secondary-foreground">{t('account', { name })}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {done && (
          <>
            <Alert tone="success">{t('done')}</Alert>
            <Link href="/" className={buttonVariants()}>
              {t('toPortal')}
            </Link>
          </>
        )}
        {needsSignIn && (
          <>
            <Alert tone="info">{t('signInRequired')}</Alert>
            <a href={`/${locale}/login?next=${encodeURIComponent(back)}`} className={buttonVariants()}>
              {t('signIn')}
            </a>
          </>
        )}
        {tooOften && <Alert tone="danger">{tAuth('tooOften')}</Alert>}
        {!done && !needsSignIn && !tooOften && error !== 'sign_in_required' && (error || !token) && (
          <>
            <Alert tone="danger">{t(error === 'email_taken' ? 'taken' : error === 'wrong_account' ? 'wrongAccount' : 'invalid')}</Alert>
            <Link href="/settings" className={buttonVariants({ variant: 'secondary' })}>
              {t('toSettings')}
            </Link>
          </>
        )}
        {canConfirm && (
          <form action={confirmEmailAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" className="w-full">
              {t('submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
