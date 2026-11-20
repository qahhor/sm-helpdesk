import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getEnv } from '@/env';
import type { Locale } from '@/i18n/locales';
import { Link } from '@/i18n/navigation';
import { describeLoginServer, getBotLink, safeReturnPath, signedInKind } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { cn } from '@/ui/cn';
import { forgetServerAction } from './actions';
import { LoginLinkForm } from './LoginLinkForm';
import { ServerAddressForm } from './ServerAddressForm';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Вход клиента (FR-ID-01..03). Клиент общего облака видит одну кнопку. Клиент выделенного сервера
// один раз вводит адрес своего Smartup. Список серверов не показывается нигде.
export default async function LoginPage({ searchParams }: PageProps<'/[locale]/login'>) {
  const params = await searchParams;
  const locale = await getLocale();
  const next = safeReturnPath(first(params.next), `/${locale}`);

  const kind = await signedInKind();
  if (kind === 'staff') redirect(`/${locale}/agent`);
  if (kind === 'client') redirect(next);

  const t = await getTranslations('auth.login');
  const tl = await getTranslations('auth.link');
  // Проверка "не робот" на формах без входа (решение 0018). Без ключа сайта виджета нет.
  const botCheck = { siteKey: getEnv().TURNSTILE_SITE_KEY, nonce: (await headers()).get('x-nonce') ?? '', locale: locale as Locale };
  const server = await describeLoginServer({ headers: new Headers(await headers()) });
  const showAddress = first(params.mode) === 'server' || server.state === 'none';
  const showLink = first(params.mode) === 'link';
  const lookup = first(params.server);
  const error = first(params.error);
  const startHref = `/${locale}/login/smartup?next=${encodeURIComponent(next)}`;
  const botLink = await getBotLink();

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-secondary-foreground">{t('intro')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert tone="danger">
            {t(
              error === 'no_server'
                ? 'errors.noServer'
                : error === 'rate_limited'
                  ? 'errors.rateLimited'
                  : error === 'server_unavailable'
                    ? 'errors.serverDown'
                    : 'errors.sso',
            )}
          </Alert>
        )}

        {server.state === 'unavailable' && <Alert tone="info">{t('serverUnavailable')}</Alert>}

        {(server.state === 'default' || server.state === 'remembered') && (
          // Обычная ссылка: вход начинает обработчик /login/smartup (см. его комментарий).
          <a href={startHref} className={cn(buttonVariants(), 'h-auto min-h-control flex-col gap-0 py-2')}>
            <span>{t('signInWithSmartup')}</span>
            {server.state === 'remembered' && <span className="text-sm font-medium opacity-90">{server.host}</span>}
          </a>
        )}

        {(server.state === 'remembered' || server.state === 'unavailable') && (
          <form action={forgetServerAction}>
            <input type="hidden" name="next" value={next} />
            <button type="submit" className="text-sm font-medium text-link underline-offset-4 hover:underline">
              {t('changeServer')}
            </button>
          </form>
        )}

        {server.state === 'default' && !showAddress && (
          <Link
            href={`/login?mode=server&next=${encodeURIComponent(next)}`}
            className="self-center text-sm font-medium text-link underline-offset-4 hover:underline"
          >
            {t('ownServer')}
          </Link>
        )}

        {showAddress && server.state !== 'remembered' && (
          <section aria-labelledby="own-server" className="flex flex-col gap-3 border-t border-border pt-4">
            <h2 id="own-server" className="text-base font-semibold">
              {t('ownServer')}
            </h2>
            {lookup === 'not_found' && <Alert tone="danger">{t('errors.serverNotFound')}</Alert>}
            {lookup === 'rate_limited' && <Alert tone="danger">{t('errors.lookupRateLimited')}</Alert>}
            <ServerAddressForm
              next={next}
              labels={{ address: t('address'), hint: t('addressHint'), submit: t('continue') }}
              botCheck={botCheck}
            />
          </section>
        )}

        {/* Вход по ссылке на подтверждённый email (FR-ID-06): для тех, кто уже подтвердил адрес в портале. */}
        {showLink ? (
          <section aria-labelledby="login-link" className="flex flex-col gap-3 border-t border-border pt-4">
            <h2 id="login-link" className="text-base font-semibold">
              {tl('request.title')}
            </h2>
            {first(params.sent) === '1' ? (
              <Alert tone="success">{tl('request.sent')}</Alert>
            ) : (
              <p className="text-sm text-secondary-foreground">{tl('request.intro')}</p>
            )}
            <LoginLinkForm next={next} labels={{ email: tl('request.email'), submit: tl('request.submit') }} botCheck={botCheck} />
          </section>
        ) : (
          <form method="get" className="border-t border-border pt-4">
            <input type="hidden" name="mode" value="link" />
            <input type="hidden" name="next" value={next} />
            <button type="submit" className={cn(buttonVariants({ variant: 'ghost' }), 'w-full')}>
              {tl('request.open')}
            </button>
          </form>
        )}

        {/* Запасной вход из бота (FR-ID-14): Smartup недоступен, а Telegram уже привязан. */}
        {botLink && (
          <p className="border-t border-border pt-4 text-sm text-secondary-foreground">
            {t('botIntro')}{' '}
            <a href={botLink} rel="noopener noreferrer" className="font-medium text-link underline-offset-4 hover:underline">
              {t('botLink')}
            </a>
          </p>
        )}

        <p className="border-t border-border pt-4 text-center text-sm text-secondary-foreground">
          <Link href="/staff/login" className="font-medium text-link underline-offset-4 hover:underline">
            {t('staffLink')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
