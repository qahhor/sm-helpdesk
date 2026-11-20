import { getTranslations } from 'next-intl/server';
import { requireClientActor } from '@/modules/hdu/api';
import { EmailSection } from './EmailSection';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Профиль клиента: адрес для входа по ссылке. Сессии появятся в задаче 13, Telegram в M4b.
export default async function ClientSettingsPage({ searchParams }: PageProps<'/[locale]/settings'>) {
  const client = await requireClientActor();
  const t = await getTranslations('client');
  return (
    <>
      <h1 className="text-2xl font-bold">{t('nav.profile')}</h1>
      <EmailSection user={client.user} status={first((await searchParams).email)} />
    </>
  );
}
