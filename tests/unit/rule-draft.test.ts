import { expect, test } from 'vitest';
import { actionDrafts, actionsPayload, ASSIGN_ME, draftOf, EMPTY_DRAFT, issuesAt, otherIssues, payloadOf } from '@/app/[locale]/(agent)/agent/settings/rules/rule-draft';

// Черновик правила в редакторе (план M8, задача 4): строки условий и действий хранятся в виде, удобном полям формы,
// и превращаются в ввод схемы правила. Проверяет ввод только сервер: черновик отдаёт и неполные строки.

const U1 = '01900000-0000-7000-8000-000000000001';
const U2 = '01900000-0000-7000-8000-000000000002';

const stored = {
  ruleId: U1,
  name: 'P1 от клиентов категории A',
  event: 'no_activity',
  hours: 48,
  conditions: {
    match: 'any' as const,
    items: [
      { field: 'priority', op: 'is', values: ['p1', 'p2'] },
      { field: 'module', op: 'is_not', values: [null, U2] },
      { field: 'tags', op: 'has_all', values: [U2] },
      { field: 'text', op: 'contains_any', words: ['касса', 'не работает'] },
      { field: 'work_time', op: 'is', value: 'off' },
      { field: 'hours_since_client', op: 'gte', value: 2.5 },
      { field: 'rating', op: 'lte', value: 2 },
    ],
  },
  actions: [
    { action: 'set_queue', queue: 'l2' },
    { action: 'assign', userId: U2 },
    { action: 'assign_round_robin' },
    { action: 'set_priority', priority: 'p1' },
    { action: 'add_tag', tagId: U2 },
    { action: 'remove_tag', tagId: U2 },
    { action: 'add_note', text: 'Проверить' },
    { action: 'reply_template', templateId: U2 },
    { action: 'notify', target: { kind: 'oncall' } },
    { action: 'notify', target: { kind: 'role', role: 'care' } },
    { action: 'notify', target: { kind: 'user', userId: U2 } },
    { action: 'snooze', hours: 24 },
    { action: 'set_status', status: 'closed' },
    { action: 'webhook', endpointId: U2 },
  ],
  isStop: true,
};

test('сохранённое правило проходит через черновик без изменений', () => {
  expect(payloadOf(draftOf(stored))).toEqual(stored);
});

test('часы есть только у события "нет активности"; пустое и нечисловое значение уходит как null', () => {
  const draft = { ...EMPTY_DRAFT, name: 'Правило', event: 'ticket_created', hours: '5' };
  expect(payloadOf(draft)).toEqual({ name: 'Правило', event: 'ticket_created', conditions: { match: 'all', items: [] }, actions: [], isStop: false });
  expect(payloadOf({ ...draft, event: 'no_activity' })).toMatchObject({ hours: 5 });
  expect(payloadOf({ ...draft, event: 'no_activity', hours: '' })).toMatchObject({ hours: null });
  expect(payloadOf({ ...draft, event: 'no_activity', hours: 'два' })).toMatchObject({ hours: null });
});

test('неполные строки отдаются как есть: их отклонит схема на сервере с путём до строки', () => {
  const draft = {
    ...EMPTY_DRAFT,
    conditions: [
      { key: 1, field: 'priority', op: 'is', values: [], text: '' },
      { key: 2, field: 'text', op: 'contains_any', values: [], text: ' касса , , чек ' },
      { key: 3, field: 'rating', op: 'is', values: [], text: '' },
    ],
    actions: [
      { key: 1, action: 'add_tag', value: '', text: '' },
      { key: 2, action: 'notify', value: '', text: '' },
      { key: 3, action: 'snooze', value: '', text: '' },
    ],
  };
  const payload = payloadOf(draft);
  expect(payload.conditions.items).toEqual([
    { field: 'priority', op: 'is', values: [] },
    { field: 'text', op: 'contains_any', words: ['касса', 'чек'] },
    { field: 'rating', op: 'is', value: null },
  ]);
  expect(payload.actions).toEqual([{ action: 'add_tag', tagId: '' }, { action: 'notify', target: { kind: 'user', userId: '' } }, { action: 'snooze', hours: null }]);
});

test('отказы схемы раскладываются по строкам, остальные показываются над формой', () => {
  const issues = [
    { path: 'name', code: 'invalid' as const },
    { path: 'conditions.items.1.values', code: 'reference_missing' as const },
    { path: 'conditions.items.10.values', code: 'invalid' as const },
    { path: 'actions.0.tagId', code: 'reference_missing' as const },
    { path: 'actions.0.tagId', code: 'reference_missing' as const },
    { path: 'actions', code: 'invalid' as const },
    { path: 'hours', code: 'hours_required' as const },
  ];
  expect(issuesAt(issues, 'conditions.items.1')).toEqual(['reference_missing']);
  expect(issuesAt(issues, 'conditions.items.10')).toEqual(['invalid']);
  expect(issuesAt(issues, 'actions.0')).toEqual(['reference_missing']);
  expect(issuesAt(issues, 'name')).toEqual(['invalid']);
  expect(issuesAt(issues, 'hours')).toEqual(['hours_required']);
  expect(issuesAt(issues, 'actions.1')).toEqual([]);
  // Отказ без строки: список действий пуст.
  expect(otherIssues(issues, 11, 1)).toEqual([{ path: 'actions', code: 'invalid' }]);
  // Строки, которой в черновике уже нет, остаются в общем списке.
  expect(otherIssues(issues, 2, 1).map((issue) => issue.path)).toEqual(['conditions.items.10.values', 'actions']);
});

test('строки действий макроса: "тот, кто запустил макрос" уходит действием assign_me и возвращается в список исполнителей', () => {
  const rows = [
    { key: 1, action: 'assign', value: ASSIGN_ME, text: '' },
    { key: 2, action: 'assign', value: U1, text: '' },
    { key: 3, action: 'reply_template', value: U2, text: '' },
    { key: 4, action: 'set_queue', value: 'l2', text: '' },
  ];
  const payload = actionsPayload(rows);
  expect(payload).toEqual([{ action: 'assign_me' }, { action: 'assign', userId: U1 }, { action: 'reply_template', templateId: U2 }, { action: 'set_queue', queue: 'l2' }]);
  expect(actionDrafts(payload)).toEqual(rows);
});
