import { notFound } from 'next/navigation';
import { getEnv } from '@/env';
import { firstParam } from '@/lib/search-params';
import { showcaseEnabled } from '@/ui/showcase';

// Проверочная страница экрана ошибки (проверка интерфейса, U6): с параметром fail=1 бросает ошибку, чтобы браузерный
// тест увидел error.tsx. Как и витрина, открыта только при HUB_SHOWCASE=1 (docs/decisions/0008-showcase-flag.md).
export default async function DevErrorPage({ searchParams }: PageProps<'/[locale]/dev/error'>) {
  if (!showcaseEnabled(getEnv())) notFound();
  if (firstParam((await searchParams).fail) === '1') throw new Error('проверочная ошибка страницы');
  return <p data-testid="dev-error-ready">fail=1</p>;
}
