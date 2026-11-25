import { getTranslations } from 'next-intl/server';
import { readIdeaMailPref, readPrefs, type StaffPrefs } from '@/modules/hdn/api/notifications';
import { mySessions, requireStaffActor } from '@/modules/hdu/api';
import { NotificationPrefsForm } from '@/ui/components/NotificationPrefsForm';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SessionsList } from '@/ui/components/SessionsList';
import { sessionItems } from '../../../sessions-view';
import { revokeOtherStaffSessionsAction, revokeStaffSessionAction, saveStaffIdeaPrefAction, saveStaffPrefsAction } from './actions';
import { firstParam } from '@/lib/search-params';

// Учётная запись сотрудника: какие письма получать (решение 7 вехи M4) и сессии, где выполнен вход.
// Сессия сотрудника живёт 12 часов (FR-ID-10).
export default async function AccountPage({ searchParams }: PageProps<'/[locale]/agent/account'>) {
  const staff = await requireStaffActor();
  const params = await searchParams;
  const prefs = (await readPrefs(staff.actor)) as StaffPrefs;
  const ideaPref = await readIdeaMailPref(staff.actor);
  const t = await getTranslations();
  const { items, labels } = await sessionItems(await mySessions());
  const status = firstParam(params.session);
  return (
    <>
      <PageHeader
        title={t('common.sessions.title')}
        breadcrumbs={[{ label: t('agent.home.title'), href: '/agent' }, { label: t('common.sessions.title') }]}
        breadcrumbsLabel={t('agent.breadcrumbs')}
      />
      <p className="text-sm text-secondary-foreground">{t('common.sessions.intro')}</p>
      {status === 'revoked' && <Alert tone="success">{t('common.sessions.done')}</Alert>}
      {status === 'others' && <Alert tone="success">{t('common.sessions.othersDone')}</Alert>}
      {status === 'not_found' && <Alert tone="danger">{t('common.sessions.notFound')}</Alert>}
      <NotificationPrefsForm
        title={t('common.notifications.settings.title')}
        intro={t('common.notifications.settings.intro')}
        options={[
          { name: 'staffMention', label: t('common.notifications.settings.mention'), checked: prefs.staffMention },
          { name: 'staffBreach', label: t('common.notifications.settings.breach'), checked: prefs.staffBreach },
        ]}
        save={saveStaffPrefsAction}
        saveLabel={t('common.notifications.settings.save')}
        savedLabel={t('common.notifications.settings.saved')}
        saved={firstParam(params.prefs) === 'saved'}
      />
      <NotificationPrefsForm
        title={t('common.notifications.settings.ideas.title')}
        intro={t('common.notifications.settings.ideas.intro')}
        options={[{ name: 'ideasEmail', label: t('common.notifications.settings.ideas.label'), checked: ideaPref.email }]}
        save={saveStaffIdeaPrefAction}
        saveLabel={t('common.notifications.settings.save')}
        savedLabel={t('common.notifications.settings.saved')}
        saved={firstParam(params.prefs) === 'ideas'}
      />
      <Card>
        <CardContent className="pt-6">
          <SessionsList items={items} labels={labels} revoke={revokeStaffSessionAction} revokeOthers={revokeOtherStaffSessionsAction} />
        </CardContent>
      </Card>
    </>
  );
}
