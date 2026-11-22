import { expect, test } from 'vitest';
import { classifyAuto } from '@/modules/hdn/inbound/classify';

// Автоответы и недоставка не создают обращений и не получают ответов (FR-EM-07, решение 17 вехи M4).

const h = (pairs: Record<string, string>): [string, string][] => Object.entries(pairs);

test.each([
  ['Auto-Submitted: auto-replied', h({ 'Auto-Submitted': 'auto-replied' }), 'ivan@example.uz', 'Re: [SUP-1]', 'auto'],
  ['Auto-Submitted: auto-generated (другой портал)', h({ 'Auto-Submitted': 'auto-generated' }), 'noreply@other.example', 'Уведомление', 'auto'],
  ['X-Autoreply', h({ 'X-Autoreply': 'yes' }), 'ivan@example.uz', 'Re: вопрос', 'auto'],
  ['X-Autorespond', h({ 'X-Autorespond': '1' }), 'ivan@example.uz', 'Re: вопрос', 'auto'],
  ['Precedence: bulk', h({ Precedence: 'bulk' }), 'news@shop.example', 'Акция', 'auto'],
  ['Precedence: auto_reply', h({ Precedence: 'auto_reply' }), 'ivan@example.uz', 'Re', 'auto'],
  ['X-Auto-Response-Suppress', h({ 'X-Auto-Response-Suppress': 'All' }), 'robot@crm.example', 'Задача', 'auto'],
  ['тема Out of Office', h({}), 'ivan@example.uz', 'Out of Office: Re: [SUP-1]', 'auto'],
  ['тема Автоответ', h({}), 'ivan@example.uz', 'Автоответ: вопрос', 'auto'],
  ['тема Avtomatik javob', h({}), 'ivan@example.uz', 'Avtomatik javob', 'auto'],
  ['отправитель mailer-daemon', h({}), 'MAILER-DAEMON@mx.example.uz', 'Message', 'bounce'],
  ['отправитель postmaster', h({}), 'postmaster@example.uz', 'Сообщение', 'bounce'],
  ['multipart/report', h({ 'Content-Type': 'multipart/report; report-type=delivery-status' }), 'mail@example.uz', 'x', 'bounce'],
  ['тема Undeliverable', h({}), 'mail@example.uz', 'Undeliverable: [SUP-1]', 'bounce'],
  ['тема Delivery Status Notification', h({}), 'mail@example.uz', 'Delivery Status Notification (Failure)', 'bounce'],
])('%s', (_name, headers, from, subject, expected) => {
  expect(classifyAuto(headers, from, subject)).toBe(expected);
});

test('обычное письмо с Precedence: normal не автоответ', () => {
  expect(classifyAuto(h({ Precedence: 'normal', 'Auto-Submitted': 'no' }), 'ivan@example.uz', 'Не печатается накладная')).toBeNull();
  expect(classifyAuto(h({ 'auto-submitted': 'No' }), 'ivan@example.uz', 'Вопрос про офис')).toBeNull();
});
