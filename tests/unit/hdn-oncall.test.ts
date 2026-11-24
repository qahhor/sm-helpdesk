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

test('текст для чата дежурных на трёх языках из messages (M4, мелкое 7)', () => {
  const payload = { template: 'oncall_p1', number: 5, title: 'x', url: '/agent/tickets/SUP-5', orgName: 'ООО Клиент' } as const;
  expect(oncallTelegramText(payload, 'https://hub.example.test')).toBe('P1: новое срочное обращение SUP-5, ООО Клиент\nhttps://hub.example.test/ru/agent/tickets/SUP-5');
  expect(oncallTelegramText(payload, 'https://hub.example.test', 'uz')).toBe('P1: yangi shoshilinch murojaat SUP-5, ООО Клиент\nhttps://hub.example.test/uz/agent/tickets/SUP-5');
  expect(oncallTelegramText({ ...payload, orgName: '' }, 'https://hub.example.test', 'en')).toBe('P1: new urgent request SUP-5\nhttps://hub.example.test/en/agent/tickets/SUP-5');
});

test('уведомление правила дежурным: номер, название правила и ссылка, без темы обращения (FR-AUTO-04)', () => {
  const payload = { template: 'oncall_rule', number: 1042, rule: 'P1 от категории A', url: '/agent/tickets/SUP-1042', title: 'Секрет клиента' } as const;
  expect(oncallTelegramText(payload, 'https://hub.example.test')).toBe('Правило «P1 от категории A»: обращение SUP-1042\nhttps://hub.example.test/ru/agent/tickets/SUP-1042');
  expect(oncallTelegramText(payload, 'https://hub.example.test', 'uz')).toContain('«P1 от категории A» qoidasi: SUP-1042');
  expect(oncallTelegramText(payload, 'https://hub.example.test', 'en')).toBe('Rule "P1 от категории A": request SUP-1042\nhttps://hub.example.test/en/agent/tickets/SUP-1042');
  expect(oncallTelegramText({ ...payload, rule: 'evil.example' }, 'https://hub.example.test')).not.toContain('evil.example');
});
