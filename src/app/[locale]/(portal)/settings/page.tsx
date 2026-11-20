import { getTranslations } from 'next-intl/server';
import { mySessions, requireClientActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { SessionsList } from '@/ui/components/SessionsList';
import { sessionItems } from '../../sessions-view';
import { revokeOtherSessionsAction, revokeSessionAction } from './actions';
import { EmailSection } from './EmailSection';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Профиль клиента: адрес для входа по ссылке и сессии на устройствах. Telegram появится в M4b.
export default async function ClientSettingsPage({ searchParams }: PageProps<'/[locale]/settings'>) {
  const client = await requireClientActor();
  const params = await searchParams;
  const t = await getTranslations();
  const { items, labels } = await sessionItems(await mySessions());
  const sessionStatus = first(params.session);
  return (
    <>
      <h1 className="text-2xl font-bold">{t('client.nav.profile')}</h1>
      <EmailSection user={client.user} status={first(params.email)} />
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
