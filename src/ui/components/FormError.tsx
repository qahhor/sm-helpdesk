import type { ReactNode, Ref } from 'react';
import { Alert } from '@/ui/components/alert';

/**
 * Показывает человеку ошибку после ответа сервера (UX-C-10; проверка интерфейса, U3 и F3): фокус встаёт на поле с
 * ошибкой или на общее сообщение, и оно прокручивается в видимую часть экрана. Без этого на телефоне сообщение
 * остаётся за экраном, и после нажатия кнопки не видно ничего.
 */
export function revealError(target: HTMLElement | null): void {
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: 'center' });
}

/** Общее сообщение формы об ошибке: принимает фокус от revealError. */
export function FormError({ ref, testId, children }: { ref: Ref<HTMLDivElement>; testId?: string; children: ReactNode }) {
  return (
    <div ref={ref} tabIndex={-1} data-testid={testId} className="rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Alert tone="danger">{children}</Alert>
    </div>
  );
}
