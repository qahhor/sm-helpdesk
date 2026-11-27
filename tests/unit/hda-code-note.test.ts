import { describe, expect, test } from 'vitest';
import { analysisNoteText } from '@/modules/hda/code/note';

// Текст заметки анализа по коду (веха M8c, задача 7; FR-CODE-08; план M8c, решение 20). Собирает портал из полей
// ответа агента с постоянными заголовками: гипотеза, уверенность, место в коде ссылкой, что проверить, вопросы
// клиенту, похожие обращения, рекомендация, записи каталога.

const fields = {
  hypothesis: 'Товара меньше, чем в заказе.',
  confidence: 0.7,
  locations: [
    { object: 'ORDER_PKG.SAVE_ORDER', path: 'db/packages/order_pkg.pkb', line: 412 },
    { object: 'STOCK_PKG', path: 'db/packages/stock_pkg.pks', line: null },
  ],
  whatToCheck: ['Остаток', 'Контроль остатков'],
  questions: ['Какой склад?'],
  similarTickets: [1001, 1002],
  recommendation: 'Проверить остаток.',
  entryKeys: ['orders.insufficient_stock'],
};

describe('заметка анализа', () => {
  test('все поля по порядку под заголовками, места ссылками, похожие обращения номерами', () => {
    const text = analysisNoteText(fields);
    const order = ['Гипотеза', 'Уверенность: 70%', 'Место в коде', 'ORDER_PKG.SAVE_ORDER, db/packages/order_pkg.pkb:412', 'STOCK_PKG, db/packages/stock_pkg.pks', 'Что проверить у клиента', '1. Остаток', 'Вопросы клиенту', 'Похожие обращения: SUP-1001, SUP-1002', 'Рекомендация', 'Записи каталога: orders.insufficient_stock'];
    let at = -1;
    for (const part of order) {
      const next = text.indexOf(part);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
  });
  test('пустые разделы не выводятся', () => {
    const text = analysisNoteText({ ...fields, locations: [], questions: [], similarTickets: [], recommendation: '', entryKeys: [] });
    expect(text).not.toMatch(/Место в коде|Вопросы клиенту|Похожие обращения|Рекомендация|Записи каталога/);
  });
});
