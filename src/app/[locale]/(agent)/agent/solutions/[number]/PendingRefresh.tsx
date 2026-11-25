'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Задача модели ещё идёт (план M5, решение 3): страница обновляется сама раз в 3 секунды, не дольше 3 минут.
// Дальше сотрудник обновляет страницу сам: задача повторяется фоновым процессом и могла ждать повтора.

const EVERY_MS = 3000;
const LIMIT_MS = 180_000;

export function PendingRefresh() {
  const router = useRouter();
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > LIMIT_MS) window.clearInterval(timer);
      else router.refresh();
    }, EVERY_MS);
    return () => window.clearInterval(timer);
  }, [router]);
  return null;
}
