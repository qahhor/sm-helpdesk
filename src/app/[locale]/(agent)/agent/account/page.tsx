import { getTranslations } from 'next-intl/server';
import { mySessions, requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SessionsList } from '@/ui/components/SessionsList';
import { sessionItems } from '../../../sessions-view';
import { revokeOtherStaffSessionsAction, revokeStaffSessionAction } from './actions';
import { firstParam } from '@/lib/search-params';

// Сессии сотрудника: где выполнен вход. Сессия сотрудника живёт 12 часов (FR-ID-10).
export default async function AccountPage({ searchParams }: PageProps<'/[locale]/agent/account'>) {
  await requireStaffActor();
  const params = await searchParams;
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
      <Card>
        <CardContent className="pt-6">
          <SessionsList items={items} labels={labels} revoke={revokeStaffSessionAction} revokeOthers={revokeOtherStaffSessionsAction} />
        </CardContent>
      </Card>
    </>
  );
}
