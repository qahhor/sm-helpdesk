import { getTranslations } from 'next-intl/server';
import { NotFoundScreen } from '@/ui/errors/NotFoundScreen';
import { AuthShell } from '@/ui/shell/AuthShell';

// Неизвестный адрес вне кабинета и рабочего места (проверка интерфейса, U7): оболочка страниц без входа, Тез и
// кнопка на главную. Сессию страница не читает: её видит и посетитель без входа (решение 0164).
export default async function NotFound() {
  const t = await getTranslations('common.notFound');
  return (
    <AuthShell wide>
      <NotFoundScreen title={t('title')} text={t('text')} href="/" label={t('home')} />
    </AuthShell>
  );
}
