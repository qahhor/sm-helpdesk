import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { RowsLimit } from '@/ui/components/RowsLimit';

// Тело таблицы с первыми строками (проверка интерфейса, U10; второй проход, F9): отрисовка на сервере показывает
// первые строки и кнопку с готовой подписью. Раскрытие и фокус проверяет браузерный тест показателей.

const rows = (count: number) => Array.from({ length: count }, (_, i) => <tr key={i} data-row={i + 1} />);
const render = (count: number, limit?: number) =>
  renderToStaticMarkup(
    <table>
      <RowsLimit showAll={`Показать все строки: ${count}`} {...(limit ? { limit } : {})}>
        {rows(count)}
      </RowsLimit>
    </table>,
  );

test('одиннадцать строк: десять и строка с кнопкой', () => {
  const html = render(11);
  expect(html.match(/data-row=/g)).toHaveLength(10);
  expect(html).not.toContain('data-row="11"');
  expect(html).toMatch(/<tr data-rows-more[^>]*>.*<button type="button"[^>]*>Показать все строки: 11<\/button>/);
});

test('десять строк и меньше: все строки, кнопки нет', () => {
  const html = render(10);
  expect(html.match(/data-row=/g)).toHaveLength(10);
  expect(html).not.toContain('<button');
});

test('свой предел строк', () => {
  const html = render(5, 3);
  expect(html.match(/data-row=/g)).toHaveLength(3);
  expect(html).toContain('Показать все строки: 5');
});
