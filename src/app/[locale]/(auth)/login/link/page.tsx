import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { completeLoginLinkAction } from './actions';
import { firstParam } from '@/lib/search-params';

// Страница ссылки для входа из письма. Открытие страницы ничего не меняет: почтовый сканер,
// который открыл ссылку первым, её не тратит. Входит только нажатие кнопки (решение 0016).
export default async function LoginLinkPage({ searchParams }: PageProps<'/[locale]/login/link'>) {
  const params = await searchParams;
  const t = await getTranslations('auth.link');
  const token = firstParam(params.token);
  const invalid = firstParam(params.error) === 'link_invalid' || !token;

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('page.title')}</h1>
        {!invalid && <p className="text-secondary-foreground">{t('page.text')}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {invalid ? (
          <>
            <Alert tone="danger">{t('page.invalid')}</Alert>
            <Link href="/login?mode=link" className={buttonVariants({ variant: 'secondary' })}>
              {t('page.again')}
            </Link>
          </>
        ) : (
          <form action={completeLoginLinkAction}>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="next" value={firstParam(params.next) ?? ''} />
            <Button type="submit" className="w-full">
              {t('page.submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
