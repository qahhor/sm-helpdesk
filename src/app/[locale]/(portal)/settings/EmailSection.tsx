import { getTranslations } from 'next-intl/server';
import type { ClientContext } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { FormField } from '@/ui/components/form-field';
import { requestEmailConfirmationAction } from './actions';

/**
 * Раздел профиля "Email для входа": подтверждённый адрес или форма, которая присылает ссылку подтверждения.
 * Данные берутся из проверенной сессии, а не из запроса браузера.
 */
export async function EmailSection({ user, status }: { user: ClientContext['user']; status?: string }) {
  const t = await getTranslations('client.settings.email');
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status === 'sent' && <Alert tone="success">{t('sent')}</Alert>}
        {status === 'invalid_input' && <Alert tone="danger">{t('errors.invalid')}</Alert>}
        {status === 'rate_limited' && <Alert tone="danger">{t('errors.rateLimited')}</Alert>}
        {user.email ? (
          <p>{t('verified', { email: user.email })}</p>
        ) : (
          <form action={requestEmailConfirmationAction} className="flex flex-col gap-4">
            <p className="text-secondary-foreground">{t('none')}</p>
            <FormField
              name="email"
              label={t('label')}
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={254}
              defaultValue={user.claimedEmail ?? ''}
              required
            />
            <Button type="submit" variant="secondary" className="self-start">
              {t('submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
