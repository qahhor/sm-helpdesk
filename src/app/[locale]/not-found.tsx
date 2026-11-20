import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export default async function NotFound() {
  const t = await getTranslations('common.notFound');
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p>{t('text')}</p>
      <Link href="/" className="font-semibold underline">
        {t('home')}
      </Link>
    </main>
  );
}
