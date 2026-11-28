import { useTranslations } from 'next-intl';
import { Skeleton } from '@/ui/components/skeleton';

// Показатели загружаются (проверка интерфейса, U6): заготовки на месте заголовка, сводки и первых разделов. Не файл
// loading.tsx: он действовал бы и на вложенную страницу пилота, а её ответ "не найдено" после начала потока терял бы
// код 404 (решение 0164).
// Заготовки скрыты от программ экранного доступа, поэтому состояние называется словом (второй проход, F14).
export function MetricsSkeleton() {
  const t = useTranslations('common');
  return (
    <div className="flex flex-col gap-4" aria-busy role="status" data-testid="page-loading">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-field w-full" />
      <div className="grid grid-cols-1 gap-3 tablet:grid-cols-2 laptop:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
