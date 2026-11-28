'use client';

import { ErrorScreen } from '@/ui/errors/ErrorScreen';

// Ошибка страницы: оболочка остаётся на месте, вместо содержимого экран "Не получилось открыть страницу"
// (проверка интерфейса, U6). Строки приходят из раскладки через контекст.
export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen reset={reset} />;
}
