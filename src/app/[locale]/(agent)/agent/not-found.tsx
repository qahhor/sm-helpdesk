import { getTranslations } from 'next-intl/server';
import { NotFoundScreen } from '@/ui/errors/NotFoundScreen';

// "Не найдено" в рабочем месте (проверка интерфейса, U7): оболочка остаётся, кнопка ведёт сотрудника в рабочее место.
export default async function AgentNotFound() {
  const t = await getTranslations('common.notFound');
  return <NotFoundScreen title={t('title')} text={t('text')} href="/agent" label={t('agentHome')} />;
}
