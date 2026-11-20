import { getLocale, getTranslations } from 'next-intl/server';
import { requireStaffActor } from '@/modules/hdu/api';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from '../../sections';
import { serverFormLabels } from '../form-labels';
import { ServerForm } from '../ServerForm';

const EMPTY = { code: '', name: '', baseUrl: '', issuer: '', clientId: '', isDefault: '', roleMap: '', authorization: '', token: '', userinfo: '', jwks: '' };

// Новый сервер Smartup. Сохранение требует входа не старше 15 минут: иначе форма предложит войти заново.
export default async function NewServerPage() {
  await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const locale = await getLocale();
  const here = `/${locale}/agent/settings/servers/new`;
  return (
    <>
      <PageHeader
        title={t('settings.servers.addTitle')}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: t('settings.servers.title'), href: '/agent/settings/servers' },
          { label: t('settings.servers.addTitle') },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('servers')}>
        <Card>
          <CardContent className="pt-6">
            <ServerForm
              mode="new"
              defaults={EMPTY}
              labels={await serverFormLabels('new')}
              reauthHref={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(here)}`}
            />
          </CardContent>
        </Card>
      </SettingsLayout>
    </>
  );
}
