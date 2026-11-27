'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { TezMark } from '@/ui/brand/TezMark';

// "Тез думает" (ТЗ 8.13, состояние "Думает"; UX-B-03; план M5b, решение 23): пока помощник готовит первый ответ,
// страница обновляется сама раз в 3 секунды, не дольше 70 секунд с создания обращения. Единственная разрешённая
// анимация: при системной настройке "меньше движения" её нет (motion-safe).

const EVERY_MS = 3_000;
const UNTIL_MS = 70_000;

export function AiThinking({ createdOn, labels }: { createdOn: string; labels: { title: string; hint: string } }) {
  const router = useRouter();
  useEffect(() => {
    const end = new Date(createdOn).getTime() + UNTIL_MS;
    const timer = setInterval(() => {
      if (Date.now() > end) clearInterval(timer);
      router.refresh();
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [createdOn, router]);
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-card bg-card-soft p-4" data-testid="tez-thinking">
      <TezMark size={32} className="motion-safe:animate-pulse" />
      <div className="flex flex-col">
        <span className="font-semibold">{labels.title}</span>
        <span className="text-sm text-muted-foreground">{labels.hint}</span>
      </div>
    </div>
  );
}
