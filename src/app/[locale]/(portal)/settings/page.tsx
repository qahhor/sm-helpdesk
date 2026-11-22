import { getTranslations } from 'next-intl/server';
import { type ClientPrefs, readPrefs } from '@/modules/hdn/api/notifications';
import { getTelegramLink, mySessions, requireClientActor, telegramEnabled } from '@/modules/hdu/api';
import { NotificationPrefsForm } from '@/ui/components/NotificationPrefsForm';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { SessionsList } from '@/ui/components/SessionsList';
import { sessionItems } from '../../sessions-view';
import { revokeOtherSessionsAction, revokeSessionAction, saveClientPrefsAction } from './actions';
import { ChannelsSection } from './ChannelsSection';
import { EmailSection } from './EmailSection';
import { firstParam } from '@/lib/search-params';

// Профиль клиента: адрес для входа по ссылке, привязка Telegram (если бот включён), какие письма получать
// (FR-NT-04) и сессии на устройствах.
export default async function ClientSettingsPage({ searchParams }: PageProps<'/[locale]/settings'>) {
  const client = await requireClientActor();
  const params = await searchParams;
  const t = await getTranslations();
  const { items, labels } = await sessionItems(await mySessions());
  const sessionStatus = firstParam(params.session);
  const prefs = (await readPrefs(client.actor)) as ClientPrefs;
  return (
    <>
      <h1 className="text-2xl font-bold">{t('client.nav.profile')}</h1>
      <EmailSection user={client.user} status={firstParam(params.email)} />
      {telegramEnabled() && <ChannelsSection link={await getTelegramLink(client)} status={firstParam(params.telegram)} />}
      <NotificationPrefsForm
        title={t('common.notifications.settings.title')}
        intro={t('common.notifications.settings.intro')}
        locked={{ label: t('common.notifications.settings.own'), hint: t('common.notifications.settings.ownHint') }}
        options={[{ name: 'watchedTickets', label: t('common.notifications.settings.watched'), checked: prefs.watchedTickets }]}
        save={saveClientPrefsAction}
        saveLabel={t('common.notifications.settings.save')}
        savedLabel={t('common.notifications.settings.saved')}
        saved={firstParam(params.prefs) === 'saved'}
      />
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">{t('common.sessions.title')}</h2>
          <p className="text-secondary-foreground">{t('common.sessions.intro')}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {sessionStatus === 'revoked' && <Alert tone="success">{t('common.sessions.done')}</Alert>}
          {sessionStatus === 'others' && <Alert tone="success">{t('common.sessions.othersDone')}</Alert>}
          {sessionStatus === 'not_found' && <Alert tone="danger">{t('common.sessions.notFound')}</Alert>}
          <SessionsList items={items} labels={labels} revoke={revokeSessionAction} revokeOthers={revokeOtherSessionsAction} />
        </CardContent>
      </Card>
    </>
  );
}
