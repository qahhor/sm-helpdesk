import { getLocale, getTranslations } from 'next-intl/server';
import { requireStaffActor } from '@/modules/hdu/api';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from '../../sections';
import { webhookFormProps } from '../form-labels';
import { WebhookForm } from '../WebhookForm';

// Новый адрес вебхука (FR-ADM-11). После сохранения форма показывает секрет подписи: один раз.
export default async function NewWebhookPage() {
  await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const w = await getTranslations('agent.settings.webhooks');
  const locale = await getLocale();
  const list = `/${locale}/agent/settings/webhooks`;
  const { labels, events } = await webhookFormProps('new');
  return (
    <>
      <PageHeader
        title={w('form.newTitle')}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: w('title'), href: '/agent/settings/webhooks' },
          { label: w('form.newTitle') },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('webhooks')}>
        <Card>
          <CardContent className="pt-6">
            <WebhookForm
              defaults={{ name: '', url: '', events: [], isEnabled: true }}
              events={events}
              labels={labels}
              reauthHref={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`${list}/new`)}`}
              endpointHref={list}
            />
          </CardContent>
        </Card>
      </SettingsLayout>
    </>
  );
}
