import type { BuiltinAction, RuleEvent } from './pref';
import type { Conditions, RuleAction } from './rule-schema';

// Модуль hdw: поставочный вид предустановленных правил (FR-AUTO-12; план M8, задача 10, решения 1 и 2). Чистый файл
// без базы. Сами правила создаёт миграция данных drizzle/0067_hdw_builtin_rules.sql с теми же значениями: тест
// сверяет строки базы с этим файлом. Отсюда берёт значения "Вернуть исходное" (restoreBuiltinRule).
//
// Предустановленное правило нельзя удалить и нельзя перевесить на другое событие; выключить, изменить условия и
// действия можно. Его собственное действие (action) другим правилам недоступно.

export type BuiltinRule = {
  /** Название правила в списке и в истории обращения: данные, как у правил администратора. */
  name: string;
  event: RuleEvent;
  /**
   * События, на которые правило срабатывает кроме своего. Сообщение дежурным о P1 нужно и при создании обращения,
   * и при поднятии приоритета: это одно поведение, поэтому одно правило.
   */
  extraEvents: readonly RuleEvent[];
  conditions: Conditions;
  actions: RuleAction[];
  isStop: boolean;
  /** Действие, которое принимает только это правило. */
  action: BuiltinAction;
};

export const BUILTIN_RULES = {
  p1_oncall: {
    name: 'P1: сообщение дежурным',
    event: 'ticket_created',
    extraEvents: ['priority_changed'],
    conditions: { match: 'all', items: [{ field: 'priority', op: 'is', values: ['p1'] }] },
    actions: [{ action: 'notify_oncall_p1' }],
    isStop: false,
    action: 'notify_oncall_p1',
  },
  sla_breach_lead: {
    name: 'Нарушение срока: руководителю линии',
    event: 'sla_breached',
    extraEvents: [],
    conditions: { match: 'all', items: [] },
    actions: [{ action: 'notify_sla_breach' }],
    isStop: false,
    action: 'notify_sla_breach',
  },
  csat_low_manager: {
    name: 'Оценка 1-2: руководителю',
    event: 'rated',
    extraEvents: [],
    conditions: { match: 'all', items: [{ field: 'rating', op: 'lte', value: 2 }] },
    actions: [{ action: 'notify_csat_low' }],
    isStop: false,
    action: 'notify_csat_low',
  },
} as const satisfies Record<string, BuiltinRule>;

export type BuiltinCode = keyof typeof BUILTIN_RULES;
export const BUILTIN_CODES = Object.keys(BUILTIN_RULES) as BuiltinCode[];

/** Поставочный вид правила по его коду. Код неизвестен (правило будущей или прошлой версии): null. */
export function builtinRule(pcode: string | null): BuiltinRule | null {
  return pcode !== null && Object.hasOwn(BUILTIN_RULES, pcode) ? BUILTIN_RULES[pcode as BuiltinCode] : null;
}

/** Коды предустановленных правил, которые срабатывают на событие сверх своего. */
export function builtinCodesForExtraEvent(event: string): BuiltinCode[] {
  return BUILTIN_CODES.filter((code) => (BUILTIN_RULES[code].extraEvents as readonly string[]).includes(event));
}

/**
 * Предустановленные правила, уведомление которых сейчас не уходит (проверка вехи M8, находка I7): правило выключено,
 * его условия или действия не проходят схему или из действий убрано его собственное уведомление. По этому списку
 * дежурные получают сигнал, а администратор видит предупреждение над списком правил. Правило, строки которого нет,
 * в список не входит: строки создаёт миграция, удалить их не даёт триггер, а в тестах таблица бывает пустой.
 */
export function inactiveBuiltinCodes(rules: readonly { pcode: string | null; isEnabled: boolean; isValid: boolean; actions: readonly { action: string }[] }[]): BuiltinCode[] {
  return BUILTIN_CODES.filter((code) => {
    const rule = rules.find((item) => item.pcode === code);
    return rule !== undefined && (!rule.isEnabled || !rule.isValid || !rule.actions.some((item) => item.action === BUILTIN_RULES[code].action));
  });
}
