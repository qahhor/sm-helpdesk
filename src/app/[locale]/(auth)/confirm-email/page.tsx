import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { confirmEmailAction } from './actions';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Подтверждение адреса по ссылке из письма (FR-ID-07). Как и у ссылки для входа,
// открытие страницы ничего не меняет: подтверждает только нажатие кнопки.
export default async function ConfirmEmailPage({ searchParams }: PageProps<'/[locale]/confirm-email'>) {
  const params = await searchParams;
  const t = await getTranslations('auth.confirmEmail');
  const token = first(params.token);
  const error = first(params.error);
  const done = first(params.done) === '1';

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {!done && !error && token && <p className="text-secondary-foreground">{t('text')}</p>}
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
        {!done && (error || !token) && (
          <>
            <Alert tone="danger">{t(error === 'email_taken' ? 'taken' : 'invalid')}</Alert>
            <Link href="/settings" className={buttonVariants({ variant: 'secondary' })}>
              {t('toSettings')}
            </Link>
          </>
        )}
        {!done && !error && token && (
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
