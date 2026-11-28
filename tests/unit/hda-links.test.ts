import { expect, test } from 'vitest';
import { removeForeignLinks, stripForeignLinks } from '@/modules/hda/links';

// Вырезание чужих ссылок из текста модели и агента (FR-CAND-09; волна 7, S-I2). Независимая проверка волны 7, находка
// R9: схема без косых черт ("data:", "tg:") считается адресом, только когда сразу за двоеточием идёт адрес.

const ALLOWED = ['smartup.uz'];

test('слово с двоеточием и пробелом после него остаётся словом', () => {
  expect(stripForeignLinks('Export data: choose a file', ALLOWED)).toBe('Export data: choose a file');
  expect(stripForeignLinks('Check the data:', ALLOWED)).toBe('Check the data:');
  expect(removeForeignLinks('Поле tg: пусто\nJavaScript: ошибка в консоли', ALLOWED)).toBe('Поле tg: пусто\nJavaScript: ошибка в консоли');
});

test('адрес со схемой без косых черт вырезается', () => {
  expect(stripForeignLinks('Откройте data:text/html;base64,PHNjcmlwdD4= и нажмите', ALLOWED)).toBe('Откройте и нажмите');
  expect(stripForeignLinks('Перейдите tg:resolve?domain=evil сейчас', ALLOWED)).toBe('Перейдите сейчас');
  expect(stripForeignLinks('javascript:alert(1)', ALLOWED)).toBe('');
});

test('чужой адрес вырезается, разрешённый остаётся', () => {
  expect(stripForeignLinks('См. https://evil.example/x и https://help.smartup.uz/orders', ALLOWED)).toBe('См. и https://help.smartup.uz/orders');
  expect(stripForeignLinks('[раздел](https://evil.example/x) и ftp://evil.example', ALLOWED)).toBe('раздел и');
});
