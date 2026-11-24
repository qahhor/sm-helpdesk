import { describe, expect, test } from 'vitest';
import { parseRule } from '@/modules/hdw/rule-schema';

// Схема правила автоматизации (FR-AUTO-01, 03, 04, 05; план M8, задача 3): закрытый перечень событий, условий и действий.

const ID = '019a1111-1111-7111-8111-111111111111';
const base = {
  name: 'P1 от категории A',
  event: 'ticket_created',
  conditions: { match: 'all', items: [{ field: 'priority', op: 'is', values: ['p1'] }] },
  actions: [{ action: 'set_queue', queue: 'l2' }],
};
const ok = (patch: Record<string, unknown> = {}) => parseRule({ ...base, ...patch });
const codes = (patch: Record<string, unknown>) => {
  const result = ok(patch);
  if (result.ok) throw new Error('правило принято, а должно быть отклонено');
  return result.issues;
};
const withCondition = (item: Record<string, unknown>) => ok({ conditions: { match: 'any', items: [item] } });
const withAction = (item: Record<string, unknown>) => ok({ actions: [item] });

test('правило с событием, условиями и действиями принимается; значения по умолчанию подставлены', () => {
  const result = ok();
  expect(result).toEqual({ ok: true, rule: { ...base, hours: null, isStop: false } });
  expect(ok({ conditions: { match: 'any', items: [] } }).ok).toBe(true);
  expect(ok({ name: '  Имя с пробелами  ', isStop: true })).toMatchObject({ ok: true, rule: { name: 'Имя с пробелами', isStop: true } });
});

test('каждое событие перечня принимается, "AI передал обращение" пока отклоняется своим кодом', () => {
  for (const event of ['ticket_created', 'client_replied', 'staff_replied', 'status_changed', 'priority_changed', 'rated', 'sla_soon', 'sla_breached']) expect(ok({ event }).ok, event).toBe(true);
  expect(codes({ event: 'ai_handoff' })).toEqual([{ path: 'event', code: 'event_not_ready' }]);
  expect(codes({ event: 'made_up' })).toEqual([{ path: 'event', code: 'invalid' }]);
});

test('срок в часах обязателен только у события "нет активности"', () => {
  expect(ok({ event: 'no_activity', hours: 48 })).toMatchObject({ ok: true, rule: { hours: 48 } });
  expect(codes({ event: 'no_activity' })).toEqual([{ path: 'hours', code: 'hours_required' }]);
  expect(codes({ hours: 5 })).toEqual([{ path: 'hours', code: 'hours_not_allowed' }]);
  expect(ok({ event: 'no_activity', hours: 0 }).ok).toBe(false);
  expect(ok({ event: 'no_activity', hours: 8761 }).ok).toBe(false);
  expect(ok({ event: 'no_activity', hours: 1.5 }).ok).toBe(false);
});

describe('условия', () => {
  test.each([
    { field: 'type', op: 'is', values: ['bug', 'question'] },
    { field: 'module', op: 'is_not', values: [ID, null] },
    { field: 'priority', op: 'is', values: ['p1'] },
    { field: 'impact', op: 'is', values: ['blocker'] },
    { field: 'status', op: 'is_not', values: ['closed'] },
    { field: 'queue', op: 'is', values: ['care'] },
    { field: 'source', op: 'is', values: ['email'] },
    { field: 'locale', op: 'is', values: ['uz'] },
    { field: 'org_category', op: 'is', values: ['A', 'none'] },
    { field: 'org', op: 'is_not', values: [ID] },
    { field: 'tags', op: 'has_all', values: [ID] },
    { field: 'tags', op: 'has_none', values: [ID] },
    { field: 'text', op: 'contains_any', words: ['печать', 'pdf'] },
    { field: 'text', op: 'contains_none', words: ['тест'] },
    { field: 'work_time', op: 'is', value: 'off' },
    { field: 'hours_since_client', op: 'gte', value: 24 },
    { field: 'hours_since_staff', op: 'lt', value: 0.5 },
    { field: 'rating', op: 'lte', value: 2 },
  ])('принимается $field $op', (item) => {
    expect(withCondition(item).ok).toBe(true);
  });

  test.each([
    ['неизвестное поле', { field: 'assignee', op: 'is', values: [ID] }],
    ['чужой оператор', { field: 'priority', op: 'has_any', values: ['p1'] }],
    ['значение не из перечня', { field: 'priority', op: 'is', values: ['p9'] }],
    ['пустой список значений', { field: 'type', op: 'is', values: [] }],
    ['больше 20 значений', { field: 'org', op: 'is', values: Array.from({ length: 21 }, () => ID) }],
    ['не идентификатор тега', { field: 'tags', op: 'has_any', values: ['срочно'] }],
    ['слово из одного знака', { field: 'text', op: 'contains_any', words: ['я'] }],
    ['слово длиннее 50 знаков', { field: 'text', op: 'contains_any', words: ['а'.repeat(51)] }],
    ['больше 10 слов', { field: 'text', op: 'contains_any', words: Array.from({ length: 11 }, (_, i) => `слово${i}`) }],
    ['регулярное выражение вместо слов', { field: 'text', op: 'matches', pattern: '.*' }],
    ['часов больше года', { field: 'hours_since_client', op: 'gte', value: 8761 }],
    ['отрицательные часы', { field: 'hours_since_staff', op: 'lt', value: -1 }],
    ['оценка 6', { field: 'rating', op: 'is', value: 6 }],
    ['лишнее поле', { field: 'work_time', op: 'is', value: 'off', script: 'x' }],
  ])('отклоняется: %s', (_name, item) => {
    expect(withCondition(item).ok).toBe(false);
  });

  test('условия без данных (сигнатура, известная проблема, причина от AI) отклоняются своим кодом', () => {
    for (const field of ['signature', 'known_problem', 'ai_reason']) {
      const result = withCondition({ field, op: 'is', value: true });
      expect(result, field).toEqual({ ok: false, issues: [{ path: 'conditions.items.0', code: 'condition_not_ready' }] });
    }
  });

  test('не больше 20 условий; соединение только "все" или "любое"', () => {
    const item = { field: 'priority', op: 'is', values: ['p1'] };
    expect(ok({ conditions: { match: 'all', items: Array.from({ length: 20 }, () => item) } }).ok).toBe(true);
    expect(ok({ conditions: { match: 'all', items: Array.from({ length: 21 }, () => item) } }).ok).toBe(false);
    expect(ok({ conditions: { match: 'xor', items: [item] } }).ok).toBe(false);
    expect(ok({ conditions: { match: 'all', items: [item], formula: 'a && b' } }).ok).toBe(false);
  });
});

describe('действия', () => {
  test.each([
    { action: 'set_queue', queue: 'care' },
    { action: 'assign', userId: ID },
    { action: 'assign_round_robin' },
    { action: 'set_priority', priority: 'p2' },
    { action: 'add_tag', tagId: ID },
    { action: 'remove_tag', tagId: ID },
    { action: 'add_note', text: 'Проверить оплату' },
    { action: 'reply_template', templateId: ID },
    { action: 'notify', target: { kind: 'user', userId: ID } },
    { action: 'notify', target: { kind: 'role', role: 'care' } },
    { action: 'notify', target: { kind: 'oncall' } },
    { action: 'snooze', hours: 720 },
    { action: 'set_status', status: 'waiting_customer' },
    { action: 'webhook', endpointId: ID },
  ])('принимается $action', (item) => {
    expect(withAction(item).ok).toBe(true);
  });

  test.each([
    ['неизвестное действие', { action: 'run_script', code: 'x' }],
    ['очередь не из перечня', { action: 'set_queue', queue: 'l3' }],
    ['заметка длиннее 2000 знаков', { action: 'add_note', text: 'а'.repeat(2001) }],
    ['пустая заметка', { action: 'add_note', text: '   ' }],
    ['ответ текстом, а не шаблоном', { action: 'reply_template', text: 'Здравствуйте' }],
    ['роль AI-сотрудника', { action: 'notify', target: { kind: 'role', role: 'agent_bot' } }],
    ['чат по номеру вместо дежурных', { action: 'notify', target: { kind: 'chat', chatId: '-100' } }],
    ['отложить на 0 часов', { action: 'snooze', hours: 0 }],
    ['отложить больше чем на 720 часов', { action: 'snooze', hours: 721 }],
    ['статус "Решено": итог выбирает сотрудник', { action: 'set_status', status: 'resolved' }],
    ['статус "Новое"', { action: 'set_status', status: 'new' }],
    ['адрес вебхука вместо записи списка', { action: 'webhook', url: 'https://example.com' }],
    ['лишнее поле', { action: 'assign_round_robin', formula: '1' }],
  ])('отклоняется: %s', (_name, item) => {
    expect(withAction(item).ok).toBe(false);
  });

  test('от одного до десяти действий', () => {
    const item = { action: 'add_note', text: 'Заметка' };
    expect(ok({ actions: [] }).ok).toBe(false);
    expect(ok({ actions: Array.from({ length: 10 }, () => item) }).ok).toBe(true);
    expect(ok({ actions: Array.from({ length: 11 }, () => item) }).ok).toBe(false);
  });
});

test('лишние поля правила и пустое название отклоняются', () => {
  expect(ok({ script: 'return true' }).ok).toBe(false);
  expect(ok({ name: '   ' }).ok).toBe(false);
  expect(ok({ name: 'а'.repeat(121) }).ok).toBe(false);
  expect(ok({ ruleId: 'x' }).ok).toBe(false);
});
