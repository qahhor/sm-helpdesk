import type { Impact, Priority, Queue, TicketSource, TicketStatus, TicketType } from '@/modules/hdt/pref';
import type { Condition, Conditions } from './rule-schema';

// Модуль hdw: проверка условий правила (FR-AUTO-03; план M8, задача 3). Чистая функция над снимком обращения:
// базу не читает, поэтому одни и те же условия проверяют и применение правила, и пробный прогон.

/** Снимок обращения на момент проверки условий. Собирает его слой core из данных модулей hdt, hdu и hdr. */
export type TicketSnapshot = {
  ticketId: string;
  orgId: string;
  number: number;
  type: TicketType;
  moduleId: string | null;
  priority: Priority;
  impact: Impact;
  status: TicketStatus;
  queue: Queue;
  source: TicketSource;
  locale: string;
  /** Категория организации клиента. null: не задана. */
  orgCategory: 'A' | 'B' | 'C' | 'D' | null;
  tagIds: string[];
  title: string;
  description: string;
  createdOn: Date;
  /** Последнее сообщение клиента и последний публичный ответ сотрудника. null: такого сообщения ещё не было. */
  lastClientMessageOn: Date | null;
  lastStaffMessageOn: Date | null;
  /** Оценка клиента от 1 до 5. null: оценки нет. */
  rating: number | null;
  /** Идёт ли рабочее время поддержки по календарю сроков SLA. */
  isWorkingTime: boolean;
  assigneeId: string | null;
};

const HOUR_MS = 3_600_000;

/**
 * Часов с последнего сообщения стороны. Сообщений этой стороны ещё не было: отсчёт от создания обращения
 * (описание обращения это первое сообщение клиента; сотрудник молчит с момента создания).
 */
const hoursSince = (last: Date | null, snapshot: TicketSnapshot, now: Date): number => (now.getTime() - (last ?? snapshot.createdOn).getTime()) / HOUR_MS;

function holds(condition: Condition, snapshot: TicketSnapshot, now: Date): boolean {
  const inList = (value: string | null, list: readonly (string | null)[], op: 'is' | 'is_not') => list.includes(value) === (op === 'is');
  switch (condition.field) {
    case 'type':
      return inList(snapshot.type, condition.values, condition.op);
    case 'module':
      return inList(snapshot.moduleId, condition.values, condition.op);
    case 'priority':
      return inList(snapshot.priority, condition.values, condition.op);
    case 'impact':
      return inList(snapshot.impact, condition.values, condition.op);
    case 'status':
      return inList(snapshot.status, condition.values, condition.op);
    case 'queue':
      return inList(snapshot.queue, condition.values, condition.op);
    case 'source':
      return inList(snapshot.source, condition.values, condition.op);
    case 'locale':
      return inList(snapshot.locale, condition.values, condition.op);
    case 'org_category':
      return inList(snapshot.orgCategory ?? 'none', condition.values, condition.op);
    case 'org':
      return inList(snapshot.orgId, condition.values, condition.op);
    case 'tags': {
      const has = (tagId: string) => snapshot.tagIds.includes(tagId);
      if (condition.op === 'has_all') return condition.values.every(has);
      return condition.values.some(has) === (condition.op === 'has_any');
    }
    case 'text': {
      // Только тема и описание обращения: переписка в условия не идёт. Подстрока без учёта регистра, не выражение.
      const text = `${snapshot.title}\n${snapshot.description}`.toLowerCase();
      return condition.words.some((item) => text.includes(item.toLowerCase())) === (condition.op === 'contains_any');
    }
    case 'work_time':
      return snapshot.isWorkingTime === (condition.value === 'working');
    case 'hours_since_client': {
      const passed = hoursSince(snapshot.lastClientMessageOn, snapshot, now);
      return condition.op === 'gte' ? passed >= condition.value : passed < condition.value;
    }
    case 'hours_since_staff': {
      const passed = hoursSince(snapshot.lastStaffMessageOn, snapshot, now);
      return condition.op === 'gte' ? passed >= condition.value : passed < condition.value;
    }
    case 'rating':
      if (snapshot.rating === null) return false;
      return condition.op === 'is' ? snapshot.rating === condition.value : condition.op === 'lte' ? snapshot.rating <= condition.value : snapshot.rating >= condition.value;
  }
}

/** Выполнены ли условия правила на снимке обращения. Пустой список условий выполнен всегда. */
export function evaluate(rule: { conditions: Conditions }, snapshot: TicketSnapshot, now: Date): boolean {
  const { match, items } = rule.conditions;
  if (items.length === 0) return true;
  return match === 'all' ? items.every((item) => holds(item, snapshot, now)) : items.some((item) => holds(item, snapshot, now));
}
