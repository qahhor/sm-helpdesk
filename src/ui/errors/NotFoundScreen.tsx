import { Link } from '@/i18n/navigation';
import { buttonVariants } from '@/ui/components/button';
import { EmptyState } from '@/ui/components/EmptyState';

/** Экран "не найдено" (проверка интерфейса, U7): один для кабинета, рабочего места и адреса вне их. Тез и кнопка 44 px. */
export function NotFoundScreen({ title, text, href, label }: { title: string; text: string; href: string; label: string }) {
  return (
    <div data-testid="not-found">
      <EmptyState
        withTez
        heading="h1"
        title={title}
        text={text}
        action={
          <Link href={href} className={buttonVariants({ className: 'min-h-11' })}>
            {label}
          </Link>
        }
      />
    </div>
  );
}
