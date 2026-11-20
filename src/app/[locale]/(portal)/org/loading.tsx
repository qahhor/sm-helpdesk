import { Skeleton } from '@/ui/components/skeleton';

// Страница организации загружается: заготовки на месте заголовка, формы и списков.
export default function OrgLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
