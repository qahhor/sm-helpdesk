import { getTranslations } from 'next-intl/server';
import { NotFoundScreen } from '@/ui/errors/NotFoundScreen';

// "Не найдено" в кабинете клиента (проверка интерфейса, U7): оболочка кабинета остаётся, клиент не теряет меню.
export default async function PortalNotFound() {
  const t = await getTranslations('common.notFound');
  return <NotFoundScreen title={t('title')} text={t('text')} href="/" label={t('home')} />;
}
