import { expect, test } from 'vitest';
import { parseMacro } from '@/modules/hdw/macro-schema';

// Схема макроса (FR-AG-15, UX-A-16; план M8, задача 6): действия правил без вебхука, распределения по кругу и
// уведомления; от одного до десяти действий.

const ID = '019a1111-1111-7111-8111-111111111111';
const base = { name: 'Запросить версию и скриншот', actions: [{ action: 'reply_template', templateId: ID }, { action: 'set_status', status: 'waiting_customer' }] };

test('макрос: название и действия из набора правил; новый макрос включён', () => {
  const parsed = parseMacro(base);
  expect(parsed).toEqual({ ok: true, macro: { ...base, isEnabled: true } });
  const all = [
    { action: 'set_queue', queue: 'l2' },
    { action: 'assign', userId: ID },
    { action: 'assign_me' },
    { action: 'set_priority', priority: 'p1' },
    { action: 'add_tag', tagId: ID },
    { action: 'remove_tag', tagId: ID },
    { action: 'add_note', text: 'Заметка' },
    { action: 'reply_template', templateId: ID },
    { action: 'snooze', hours: 24 },
    { action: 'set_status', status: 'in_development' },
  ];
  expect(parseMacro({ macroId: ID, name: '  Все действия  ', actions: all, isEnabled: false })).toEqual({ ok: true, macro: { macroId: ID, name: 'Все действия', actions: all, isEnabled: false } });
});

test.each([
  ['вебхук', [{ action: 'webhook', endpointId: ID }]],
  ['распределение по кругу', [{ action: 'assign_round_robin' }]],
  ['уведомление', [{ action: 'notify', target: { kind: 'oncall' } }]],
  ['очередь Customer Care', [{ action: 'set_queue', queue: 'care' }]],
  ['статус "Решено"', [{ action: 'set_status', status: 'resolved' }]],
  ['исполнитель "я" с идентификатором', [{ action: 'assign_me', userId: ID }]],
  ['произвольный код', [{ action: 'eval', code: '1' }]],
  ['нет действий', []],
  ['одиннадцать действий', Array.from({ length: 11 }, () => ({ action: 'assign_me' }))],
])('макрос не принимает: %s', (_name, actions) => {
  const parsed = parseMacro({ ...base, actions });
  expect(parsed.ok).toBe(false);
});

test('отказ называет путь до поля; лишние поля и поля правила не принимаются', () => {
  expect(parseMacro({ ...base, actions: [{ action: 'snooze', hours: 0 }] })).toEqual({ ok: false, issues: [{ path: 'actions.0.hours', code: 'invalid' }] });
  expect(parseMacro({ ...base, name: '' })).toEqual({ ok: false, issues: [{ path: 'name', code: 'invalid' }] });
  for (const extra of [{ event: 'ticket_created' }, { conditions: { match: 'all', items: [] } }, { isStop: true }, { script: 'x' }]) expect(parseMacro({ ...base, ...extra }).ok).toBe(false);
});
