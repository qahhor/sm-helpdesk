'use client';

import { Children, type ReactNode, useState } from 'react';
import { buttonVariants } from '@/ui/components/button';

/**
 * Тело таблицы с первыми строками и кнопкой "Показать все" (проверка интерфейса, U10): длинная таблица не растягивает
 * страницу на несколько экранов. Строки уже отрисованы на сервере; кнопка только показывает остальные.
 */
export function RowsLimit({ children, limit = 10, showAll }: { children: ReactNode; limit?: number; /** Подпись кнопки готовой строкой с числом строк. */ showAll: string }) {
  const rows = Children.toArray(children);
  const [open, setOpen] = useState(false);
  const cut = !open && rows.length > limit;
  return (
    <tbody>
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
