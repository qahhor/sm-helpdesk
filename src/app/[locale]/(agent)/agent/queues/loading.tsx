import { Skeleton } from '@/ui/components/skeleton';

// Очереди загружаются (проверка интерфейса, U6): заготовки на месте заголовка, списка очередей и таблицы.
export default function QueuesLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy data-testid="page-loading">
      <Skeleton className="h-8 w-48" />
      <div className="flex flex-col gap-4 laptop:flex-row laptop:items-start">
        <Skeleton className="h-64 w-full laptop:w-60 laptop:shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Skeleton className="h-field w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    </div>
  );
}
