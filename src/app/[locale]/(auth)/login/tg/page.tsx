import { getTranslations } from 'next-intl/server';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { completeTelegramLoginAction } from './actions';
import { firstParam } from '@/lib/search-params';

// Страница ссылки входа из бота Telegram (FR-ID-14). Открытие страницы ничего не меняет: Telegram
// открывает ссылки для предпросмотра, и ссылка от этого не сгорает. Входит только нажатие кнопки.
export default async function TelegramLoginPage({ searchParams }: PageProps<'/[locale]/login/tg'>) {
  const params = await searchParams;
  const t = await getTranslations('auth.telegram');
  const tAuth = await getTranslations('auth');
  const token = firstParam(params.token);
  const invalid = firstParam(params.error) === 'link_invalid' || !token;

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {!invalid && <p className="text-secondary-foreground">{t('text')}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {invalid ? (
          <Alert tone="danger">{t('invalid')}</Alert>
        ) : (
          <>
            {firstParam(params.error) === 'rate_limited' && <Alert tone="danger">{tAuth('tooOften')}</Alert>}
          <form action={completeTelegramLoginAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit" className="w-full">
              {t('submit')}
            </Button>
          </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
