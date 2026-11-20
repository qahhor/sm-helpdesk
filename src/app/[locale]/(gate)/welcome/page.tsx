import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireClientActor, safeReturnPath } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { FormField } from '@/ui/components/form-field';
import { sendWelcomeLinkAction, skipWelcomeAction } from './actions';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Шаг первого входа (FR-ID-07): после входа через Smartup портал один раз предлагает указать email.
// У большинства пользователей Smartup адреса нет (решение 89 ТЗ), поэтому шаг можно пропустить.
// Привязка Telegram появится здесь в вехе M4b.
export default async function WelcomePage({ searchParams }: PageProps<'/[locale]/welcome'>) {
  const client = await requireClientActor();
  const params = await searchParams;
  const locale = await getLocale();
  const next = safeReturnPath(first(params.next), `/${locale}`);
  const sent = first(params.sent) === '1';
  if (!sent && (client.user.onboarded || client.user.hasVerifiedEmail)) redirect(next);

  const t = await getTranslations('auth.welcome');
  const error = first(params.error);
  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title', { name: client.user.name })}</h1>
        {!sent && <p className="text-secondary-foreground">{t('text')}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sent ? (
          <>
            <Alert tone="success">{t('sent')}</Alert>
            <a href={next} className={buttonVariants()}>
              {t('continue')}
            </a>
          </>
        ) : (
          <form className="flex flex-col gap-4">
            <input type="hidden" name="next" value={next} />
            {error && <Alert tone="danger">{t(error === 'rate_limited' ? 'errors.rateLimited' : 'errors.invalid')}</Alert>}
            <FormField
              name="email"
              label={t('email')}
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              defaultValue={client.user.claimedEmail ?? ''}
            />
            <Button type="submit" formAction={sendWelcomeLinkAction}>
              {t('send')}
            </Button>
            {/* Пропуск не требует адреса: проверка поля браузером здесь не нужна. */}
            <Button type="submit" variant="secondary" formAction={skipWelcomeAction} formNoValidate>
              {t('skip')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
