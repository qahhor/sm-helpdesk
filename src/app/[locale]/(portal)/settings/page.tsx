import { getTranslations } from 'next-intl/server';
import { type ClientPrefs, readIdeaMailPref, readPrefs } from '@/modules/hdn/api/notifications';
import { getTelegramLink, mySessions, requireClientActor, telegramEnabled } from '@/modules/hdu/api';
import { telegramLinked } from '@/modules/hdu/api/recipients';
import { ClientChannelsForm } from '@/ui/components/ClientChannelsForm';
import { NotificationPrefsForm } from '@/ui/components/NotificationPrefsForm';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { SessionsList } from '@/ui/components/SessionsList';
import { sessionItems } from '../../sessions-view';
import { revokeOtherSessionsAction, revokeSessionAction, saveClientIdeaPrefAction, saveClientPrefsAction } from './actions';
import { ChannelsSection } from './ChannelsSection';
import { EmailSection } from './EmailSection';
import { firstParam } from '@/lib/search-params';

// Профиль клиента: адрес для входа по ссылке, привязка Telegram (если бот включён), каналы уведомлений
// (FR-NT-04, FR-NT-14), письма об идеях (план M7, задача 8) и сессии на устройствах.
export default async function ClientSettingsPage({ searchParams }: PageProps<'/[locale]/settings'>) {
  const client = await requireClientActor();
  const params = await searchParams;
  const t = await getTranslations();
  const { items, labels } = await sessionItems(await mySessions());
  const sessionStatus = firstParam(params.session);
  const prefs = (await readPrefs(client.actor)) as ClientPrefs;
  const prefsStatus = firstParam(params.prefs);
  const ideaPref = await readIdeaMailPref(client.actor);
  const botOn = telegramEnabled();
  const telegramActive = botOn && (await telegramLinked(client.actor.userId));
  const link = botOn ? await getTelegramLink(client) : null;
  return (
    <>
      <h1 className="text-2xl font-bold">{t('client.nav.profile')}</h1>
      <EmailSection user={client.user} status={firstParam(params.email)} />
      {botOn && <ChannelsSection link={link} status={firstParam(params.telegram)} />}
      <ClientChannelsForm
        rows={[
          { key: 'own', label: t('common.notifications.settings.own'), ...prefs.own },
          { key: 'watched', label: t('common.notifications.settings.watched'), ...prefs.watched },
        ]}
        labels={{
          title: t('common.notifications.settings.client.title'),
          intro: t('common.notifications.settings.client.intro'),
          kind: t('common.notifications.settings.client.kind'),
          email: t('common.notifications.settings.client.email'),
          telegram: t('common.notifications.settings.client.telegram'),
          ownRule: t('common.notifications.settings.client.ownRule'),
          telegramMissing: t('common.notifications.settings.client.telegramMissing'),
          telegramBlocked: t('common.notifications.settings.client.telegramBlocked'),
          telegramLink: t('common.notifications.settings.client.telegramLink'),
          needTelegram: t('common.notifications.settings.client.needTelegram'),
          ownFallback: t('common.notifications.settings.client.ownFallback'),
          save: t('common.notifications.settings.save'),
          saved: t('common.notifications.settings.saved'),
        }}
        telegram={botOn ? { active: telegramActive, blocked: link?.blocked === true, linkHref: '#telegram' } : null}
        status={prefsStatus === 'saved' || prefsStatus === 'need_telegram' ? prefsStatus : null}
        ownFallback={!prefs.own.email && !telegramActive}
        save={saveClientPrefsAction}
      />
      <NotificationPrefsForm
        title={t('common.notifications.settings.ideas.title')}
        intro={t('common.notifications.settings.ideas.intro')}
        options={[{ name: 'ideasEmail', label: t('common.notifications.settings.ideas.label'), checked: ideaPref.email }]}
        save={saveClientIdeaPrefAction}
        saveLabel={t('common.notifications.settings.save')}
        savedLabel={t('common.notifications.settings.saved')}
        saved={prefsStatus === 'ideas'}
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
