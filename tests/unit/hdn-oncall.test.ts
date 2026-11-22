import { expect, test } from 'vitest';
import { oncallTelegramText } from '@/modules/hdn/core/oncall-text';

// Сообщение в служебный чат дежурных о P1 (FR-SLA-07, решение 8 вехи M4; раздел 14.6 ТЗ: в Telegram уходят номер
// и ссылка без текста обращения).

test('сообщение дежурным: номер, приоритет, организация и ссылка без текста клиента', () => {
  const text = oncallTelegramText(
    { template: 'oncall_p1', number: 1042, title: 'Секрет: пароль от склада 12345', url: '/agent/tickets/SUP-1042', orgName: 'ООО Клиент' },
    'https://hub.example.test',
  );
  expect(text).toContain('SUP-1042');
  expect(text).toContain('P1');
  expect(text).toContain('ООО Клиент');
  expect(text).toContain('https://hub.example.test/ru/agent/tickets/SUP-1042');
  expect(text).not.toContain('Секрет');
  expect(text).not.toContain('12345');
});

test('название организации, похожее на ссылку, не становится ссылкой', () => {
  const text = oncallTelegramText({ template: 'oncall_p1', number: 7, title: 'x', url: '/agent/tickets/SUP-7', orgName: 'evil.example' }, 'https://hub.example.test');
  expect(text).not.toContain('evil.example');
});
