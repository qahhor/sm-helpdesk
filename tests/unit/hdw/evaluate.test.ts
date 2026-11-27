import { expect, test } from 'vitest';
import { evaluate, type TicketSnapshot } from '@/modules/hdw/evaluate';
import type { Condition } from '@/modules/hdw/rule-schema';

// Проверка условий правила на снимке обращения (FR-AUTO-03; план M8, задача 3): каждое поле и каждый оператор.

const NOW = new Date('2026-11-24T10:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const TAG_A = '019a0000-0000-7000-8000-00000000000a';
const TAG_B = '019a0000-0000-7000-8000-00000000000b';
const MODULE = '019a0000-0000-7000-8000-0000000000aa';
const ORG = '019a0000-0000-7000-8000-0000000000bb';
const OTHER = '019a0000-0000-7000-8000-0000000000cc';

const snapshot = (patch: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  ticketId: '019a0000-0000-7000-8000-000000000001',
  orgId: ORG,
  number: 1042,
  type: 'bug',
  moduleId: MODULE,
  priority: 'p2',
  impact: 'major',
  status: 'in_progress',
  queue: 'l1',
  source: 'portal',
  locale: 'ru',
  orgCategory: 'A',
  tagIds: [TAG_A],
  title: 'Не печатается Накладная',
  description: 'После обновления печать в PDF падает с ошибкой',
  createdOn: hoursAgo(100),
  lastClientMessageOn: hoursAgo(30),
  lastStaffMessageOn: hoursAgo(5),
  rating: null,
  isWorkingTime: true,
  assigneeId: null,
  aiHandoffReason: null,
  ...patch,
});
const one = (item: Condition, patch: Partial<TicketSnapshot> = {}) => evaluate({ conditions: { match: 'all', items: [item] } }, snapshot(patch), NOW);

test('пустой список условий выполнен всегда', () => {
  expect(evaluate({ conditions: { match: 'all', items: [] } }, snapshot(), NOW)).toBe(true);
  expect(evaluate({ conditions: { match: 'any', items: [] } }, snapshot(), NOW)).toBe(true);
});

test('"все" требует каждое условие, "любое" хотя бы одно', () => {
  const yes: Condition = { field: 'priority', op: 'is', values: ['p2'] };
  const no: Condition = { field: 'type', op: 'is', values: ['question'] };
  expect(evaluate({ conditions: { match: 'all', items: [yes, no] } }, snapshot(), NOW)).toBe(false);
  expect(evaluate({ conditions: { match: 'any', items: [yes, no] } }, snapshot(), NOW)).toBe(true);
  expect(evaluate({ conditions: { match: 'all', items: [yes, yes] } }, snapshot(), NOW)).toBe(true);
  expect(evaluate({ conditions: { match: 'any', items: [no, no] } }, snapshot(), NOW)).toBe(false);
});

test.each([
  ['type', 'bug', 'question'],
  ['priority', 'p2', 'p1'],
  ['impact', 'major', 'minor'],
  ['status', 'in_progress', 'closed'],
  ['queue', 'l1', 'care'],
  ['source', 'portal', 'email'],
  ['locale', 'ru', 'uz'],
] as const)('%s: "равно" и "не равно" по списку значений', (field, own, other) => {
  const item = (op: 'is' | 'is_not', values: string[]) => ({ field, op, values }) as Condition;
  expect(one(item('is', [other, own]))).toBe(true);
  expect(one(item('is', [other]))).toBe(false);
  expect(one(item('is_not', [other]))).toBe(true);
  expect(one(item('is_not', [own, other]))).toBe(false);
});

test('модуль: идентификатор или "не указан"', () => {
  expect(one({ field: 'module', op: 'is', values: [MODULE] })).toBe(true);
  expect(one({ field: 'module', op: 'is', values: [null] })).toBe(false);
  expect(one({ field: 'module', op: 'is', values: [null] }, { moduleId: null })).toBe(true);
  expect(one({ field: 'module', op: 'is_not', values: [null, OTHER] })).toBe(true);
  expect(one({ field: 'module', op: 'is_not', values: [null] }, { moduleId: null })).toBe(false);
});

test('категория организации: буква или "не задана"', () => {
  expect(one({ field: 'org_category', op: 'is', values: ['A', 'B'] })).toBe(true);
  expect(one({ field: 'org_category', op: 'is', values: ['none'] })).toBe(false);
  expect(one({ field: 'org_category', op: 'is', values: ['none'] }, { orgCategory: null })).toBe(true);
  expect(one({ field: 'org_category', op: 'is_not', values: ['A'] })).toBe(false);
  expect(one({ field: 'org_category', op: 'is_not', values: ['A'] }, { orgCategory: null })).toBe(true);
});

test('организация: по списку идентификаторов', () => {
  expect(one({ field: 'org', op: 'is', values: [ORG] })).toBe(true);
  expect(one({ field: 'org', op: 'is', values: [OTHER] })).toBe(false);
  expect(one({ field: 'org', op: 'is_not', values: [OTHER] })).toBe(true);
  expect(one({ field: 'org', op: 'is_not', values: [ORG] })).toBe(false);
});

test('теги: есть любой, есть все, нет ни одного', () => {
  expect(one({ field: 'tags', op: 'has_any', values: [TAG_A, TAG_B] })).toBe(true);
  expect(one({ field: 'tags', op: 'has_any', values: [TAG_B] })).toBe(false);
  expect(one({ field: 'tags', op: 'has_all', values: [TAG_A, TAG_B] })).toBe(false);
  expect(one({ field: 'tags', op: 'has_all', values: [TAG_A, TAG_B] }, { tagIds: [TAG_B, TAG_A] })).toBe(true);
  expect(one({ field: 'tags', op: 'has_none', values: [TAG_B] })).toBe(true);
  expect(one({ field: 'tags', op: 'has_none', values: [TAG_A, TAG_B] })).toBe(false);
});

test('текст: подстрока без учёта регистра в теме и описании, не выражение', () => {
  expect(one({ field: 'text', op: 'contains_any', words: ['накладная'] })).toBe(true);
  expect(one({ field: 'text', op: 'contains_any', words: ['pdf', 'нет такого'] })).toBe(true);
  expect(one({ field: 'text', op: 'contains_any', words: ['счёт'] })).toBe(false);
  expect(one({ field: 'text', op: 'contains_none', words: ['счёт'] })).toBe(true);
  expect(one({ field: 'text', op: 'contains_none', words: ['счёт', 'ОШИБКОЙ'] })).toBe(false);
  // Знаки выражений ищутся буквально.
  expect(one({ field: 'text', op: 'contains_any', words: ['.*'] })).toBe(false);
  expect(one({ field: 'text', op: 'contains_any', words: ['a.*b'] }, { description: 'строка a.*b внутри' })).toBe(true);
});

test('рабочее и нерабочее время', () => {
  expect(one({ field: 'work_time', op: 'is', value: 'working' })).toBe(true);
  expect(one({ field: 'work_time', op: 'is', value: 'off' })).toBe(false);
  expect(one({ field: 'work_time', op: 'is', value: 'off' }, { isWorkingTime: false })).toBe(true);
  expect(one({ field: 'work_time', op: 'is', value: 'working' }, { isWorkingTime: false })).toBe(false);
});

test('часов с последнего сообщения клиента и сотрудника: не меньше и меньше', () => {
  expect(one({ field: 'hours_since_client', op: 'gte', value: 30 })).toBe(true);
  expect(one({ field: 'hours_since_client', op: 'gte', value: 30.5 })).toBe(false);
  expect(one({ field: 'hours_since_client', op: 'lt', value: 30 })).toBe(false);
  expect(one({ field: 'hours_since_client', op: 'lt', value: 31 })).toBe(true);
  expect(one({ field: 'hours_since_staff', op: 'gte', value: 5 })).toBe(true);
  expect(one({ field: 'hours_since_staff', op: 'gte', value: 6 })).toBe(false);
  expect(one({ field: 'hours_since_staff', op: 'lt', value: 6 })).toBe(true);
  expect(one({ field: 'hours_since_staff', op: 'lt', value: 5 })).toBe(false);
});

test('сообщений стороны ещё не было: отсчёт от создания обращения', () => {
  expect(one({ field: 'hours_since_staff', op: 'gte', value: 100 }, { lastStaffMessageOn: null })).toBe(true);
  expect(one({ field: 'hours_since_staff', op: 'gte', value: 101 }, { lastStaffMessageOn: null })).toBe(false);
  expect(one({ field: 'hours_since_client', op: 'lt', value: 101 }, { lastClientMessageOn: null })).toBe(true);
  expect(one({ field: 'hours_since_client', op: 'lt', value: 100 }, { lastClientMessageOn: null })).toBe(false);
});

test('оценка: равно, не больше, не меньше; без оценки условие не выполнено', () => {
  expect(one({ field: 'rating', op: 'is', value: 2 }, { rating: 2 })).toBe(true);
  expect(one({ field: 'rating', op: 'is', value: 2 }, { rating: 3 })).toBe(false);
  expect(one({ field: 'rating', op: 'lte', value: 2 }, { rating: 1 })).toBe(true);
  expect(one({ field: 'rating', op: 'lte', value: 2 }, { rating: 3 })).toBe(false);
  expect(one({ field: 'rating', op: 'gte', value: 4 }, { rating: 5 })).toBe(true);
  expect(one({ field: 'rating', op: 'gte', value: 4 }, { rating: 3 })).toBe(false);
  for (const op of ['is', 'lte', 'gte'] as const) expect(one({ field: 'rating', op, value: 3 })).toBe(false);
});
