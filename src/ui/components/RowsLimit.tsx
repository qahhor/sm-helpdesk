'use client';

import { Children, type ReactNode, useEffect, useRef, useState } from 'react';
import { buttonVariants } from '@/ui/components/button';

/**
 * Тело таблицы с первыми строками и кнопкой "Показать все" (проверка интерфейса, U10): длинная таблица не растягивает
 * страницу на несколько экранов. Строки уже отрисованы на сервере; кнопка только показывает остальные. Кнопка после
 * нажатия исчезает, поэтому фокус переходит на первую из добавленных строк (второй проход, F9): клавиатура и чтение
 * с экрана продолжают с места раскрытия, а не с начала страницы.
 */
export function RowsLimit({ children, limit = 10, showAll }: { children: ReactNode; limit?: number; /** Подпись кнопки готовой строкой с числом строк. */ showAll: string }) {
  const rows = Children.toArray(children);
  const [open, setOpen] = useState(false);
  const cut = !open && rows.length > limit;
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (!open) return;
    const first = body.current?.rows[limit];
    if (!first) return;
    first.tabIndex = -1;
    first.focus();
  }, [open, limit]);
  return (
    <tbody ref={body}>
      {cut ? rows.slice(0, limit) : rows}
      {cut && (
        <tr data-rows-more>
          {/* Ячейка на всю ширину: число больше числа столбцов браузер обрезает до ширины таблицы. */}
          <td colSpan={99} className="px-3 py-2">
            <button type="button" onClick={() => setOpen(true)} className={buttonVariants({ variant: 'secondary', size: 'small' })}>
              {showAll}
            </button>
          </td>
        </tr>
      )}
    </tbody>
  );
}
