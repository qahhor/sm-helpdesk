import 'server-only';
import type { Tx } from '@/db/client';
import { logEvent } from '@/lib/log';
import { notifyTx } from '@/modules/hdn/api/notifications';
import { enqueueTx } from '@/modules/hdn/api/outbox';
import { renderTemplate, type ReplyTemplate, type Tag, tagsByIdTx, templatesByIdTx } from '@/modules/hdr/api';
import {
  isHdtError,
  type LockedTicket,
  type RuleActionResult,
  ruleAddNoteTx,
  ruleAddTagTx,
  ruleAssignTx,
  ruleNotifyBreachTx,
  ruleNotifyCsatLowTx,
  ruleOncallP1Tx,
  rulePickRoundRobinTx,
  ruleRemoveTagTx,
  ruleReplyTx,
  ruleSetPriorityTx,
  ruleSetQueueTx,
  ruleSetStatusTx,
  ruleSnoozeTx,
} from '@/modules/hdt/api/automation';
import { canTransition, type Queue, TRANSFERABLE_STATUSES } from '@/modules/hdt/pref';
import { ruleLinkProblemTx } from '@/modules/hdp/api/links';
import { requestCodeAnalysisBySystemTx } from '@/modules/hda/api/code-analysis';
import type { StaffMember } from '@/modules/hdu/api/automation';
import type { TicketSnapshot } from '../evaluate';
import { isHdwError } from '../error';
import { BUILTIN_ACTIONS, CSAT_LOW_ROLE, LINE_ROLES, type RuleEventKind } from '../pref';
import type { RuleAction } from '../rule-schema';
import type { ActionDone } from '../schema';
import { enqueueRuleDelivery } from './deliveries';
import { endpointsByIdTx } from './webhooks';

// Модуль hdw, слой core: действия правила (FR-AUTO-04, 07, 10, 11; план M8, задача 3). Обращение меняют функции
// модуля обращений: с теми же проверками, историей и журналом, что у действий сотрудника. Здесь выбор исполнителя,
// текст шаблона, получатели уведомления и постановка доставки вебхука. Ссылка на удалённый тег, шаблон или сотрудника даёт отказ
// действия с кодом, а не сбой срабатывания: остальные действия правила выполняются.

/** Действующие сотрудники: читаются один раз на запуск разбора (другое подключение, роль hub_auth). */
export type Roster = () => Promise<StaffMember[]>;

export type ActionContext = {
  tx: Tx;
  ticket: LockedTicket;
  /** Снимок обращения до действий правила: язык, тема и номер для ответа и уведомлений. */
  snapshot: TicketSnapshot;
  rule: { ruleId: string; name: string; event: RuleEventKind };
  /** Событие hdc_domain_events, которое разбирает правило. Пусто: событие "нет активности". */
  eventId: string | null;
  /** Подробности события: какой срок нарушен. Пусто: событие "нет активности". */
  eventPayload?: Record<string, unknown> | null;
  now: Date;
  roster: Roster;
  /**
   * Повторить событие больше нельзя: это последняя попытка его разбора либо событие "нет активности", у которого
   * счётчика попыток нет. Тогда непредвиденный сбой обычного действия записывается отказом, а не бросается.
   */
  lastAttempt: boolean;
};

/**
 * Действие "вызвать вебхук": ставит доставку в транзакции правила (core/deliveries.ts, enqueueRuleDelivery).
 * Тесты подменяют постановку, чтобы проверить откат действия в точке сохранения.
 */
export type WebhookDeliverer = (
  tx: Tx,
  input: { endpointId: string; ticketId: string; orgId: string; ruleId: string; event: RuleEventKind; eventId: string | null; now: Date },
) => Promise<{ ok: boolean; detail?: string; name?: string }>;
const hooks = globalThis as typeof globalThis & { __hubWebhookDeliverer?: WebhookDeliverer };

/** Подмена постановки доставки в тестах. null возвращает настоящую. */
export function setWebhookDeliverer(deliver: WebhookDeliverer | null): void {
  hooks.__hubWebhookDeliverer = deliver ?? undefined;
}
export const deliverWebhook: WebhookDeliverer = (tx, input) => (hooks.__hubWebhookDeliverer ?? enqueueRuleDelivery)(tx, input);

const WRITER_ROLES: readonly string[] = ['agent_l1', 'agent_l2', 'care', 'admin'];
const HOUR_MS = 3_600_000;

const report = (action: RuleAction['action'], result: RuleActionResult): ActionDone =>
  result.ok
    ? { action, ok: true, ...(result.from !== undefined ? { from: result.from } : {}), ...(result.to !== undefined ? { to: result.to } : {}), ...(result.unchanged ? { unchanged: true } : {}) }
    : { action, ok: false, detail: result.detail };

/** Кандидаты распределения по кругу: действующие сотрудники линии очереди обращения. */
export function lineCandidates(roster: readonly StaffMember[], queue: string): StaffMember[] {
  const roles: readonly string[] = LINE_ROLES[queue as Queue] ?? [];
  return roster.filter((member) => roles.includes(member.role));
}

async function run(c: ActionContext, tx: Tx, action: RuleAction): Promise<RuleActionResult> {
  const { ticket, snapshot } = c;
  switch (action.action) {
    case 'set_queue':
      return ruleSetQueueTx(tx, ticket, action.queue);
    case 'assign': {
      // Назначить можно только действующего сотрудника, который ведёт обращения (ТЗ 5.2: не product).
      const member = (await c.roster()).find((item) => item.userId === action.userId && WRITER_ROLES.includes(item.role));
      if (!member) return { ok: false, detail: 'user_missing' };
      return ruleAssignTx(tx, ticket, { id: member.userId, name: member.name });
    }
    case 'assign_round_robin': {
      const candidates = lineCandidates(await c.roster(), ticket.queue);
      if (candidates.length === 0) return { ok: false, detail: 'no_candidates' };
      // Исполнитель уже из этой линии: обращение остаётся у него, повторное срабатывание его не перекидывает.
      const current = candidates.find((item) => item.userId === ticket.assigneeId);
      if (current) return { ok: true, unchanged: true, from: current.name, to: current.name };
      const picked = await rulePickRoundRobinTx(tx, candidates.map((item) => item.userId));
      const member = candidates.find((item) => item.userId === picked);
      if (!member) return { ok: false, detail: 'no_candidates' };
      return ruleAssignTx(tx, ticket, { id: member.userId, name: member.name });
    }
    case 'set_priority':
      return ruleSetPriorityTx(tx, ticket, action.priority);
    case 'add_tag':
      return ruleAddTagTx(tx, ticket, action.tagId);
    case 'remove_tag':
      return ruleRemoveTagTx(tx, ticket, action.tagId);
    case 'add_note':
      return ruleAddNoteTx(tx, ticket, action.text);
    case 'reply_template': {
      const template = (await templatesByIdTx(tx, [action.templateId])).get(action.templateId);
      if (!template) return { ok: false, detail: 'template_missing' };
      if (!template.isEnabled) return { ok: false, detail: 'template_disabled' };
      // Текст на языке обращения; перевода нет: русский, как у шаблонов в поле ответа (FR-AG-06).
      const { text } = renderTemplate(template, snapshot.locale);
      if (!text.trim()) return { ok: false, detail: 'template_missing' };
      const result = await ruleReplyTx(tx, ticket, text);
      return result.ok ? { ok: true, to: template.title } : result;
    }
    case 'notify':
      return notify(c, tx, action.target);
    case 'snooze':
      return ruleSnoozeTx(tx, ticket, new Date(c.now.getTime() + action.hours * HOUR_MS));
    case 'set_status':
      return ruleSetStatusTx(tx, ticket, action.status);
    case 'webhook': {
      const result = await deliverWebhook(tx, { endpointId: action.endpointId, ticketId: ticket.ticketId, orgId: ticket.orgId, ruleId: c.rule.ruleId, event: c.rule.event, eventId: c.eventId, now: c.now });
      return result.ok ? { ok: true, ...(result.name !== undefined ? { to: result.name } : {}) } : { ok: false, detail: result.detail ?? 'webhook_failed' };
    }
    // Привязка к известной проблеме (веха M5c, решение 11): общая функция привязки модуля проблем.
    case 'link_known_problem':
      return ruleLinkProblemTx(tx, { ticketId: ticket.ticketId, problemNumber: action.problemNumber });
    // Анализ по коду (веха M8c, FR-CODE-09): запрос от системы теми же проверками, что кнопка второй линии.
    case 'request_code_analysis': {
      const outcome = await requestCodeAnalysisBySystemTx(tx, { ticketId: ticket.ticketId, orgId: ticket.orgId, ruleId: c.rule.ruleId });
      if (outcome === 'ai_disabled') return { ok: false, detail: 'ai_disabled' };
      return outcome === 'pending' ? { ok: true, unchanged: true } : { ok: true };
    }
    // Действия предустановленных правил (FR-AUTO-12): прежние встроенные уведомления модуля обращений.
    case 'notify_oncall_p1':
      return ruleOncallP1Tx(tx, ticket);
    case 'notify_sla_breach': {
      // Какой срок нарушен, говорит событие sla_breached. Другое событие срока не несёт: уведомлять не о чем.
      const deadline = c.eventPayload?.deadline;
      if (deadline !== 'first_response' && deadline !== 'resolution') return { ok: false, detail: 'event_mismatch' };
      return ruleNotifyBreachTx(tx, ticket, deadline);
    }
    case 'notify_csat_low':
      return ruleNotifyCsatLowTx(tx, ticket, (await c.roster()).filter((item) => item.role === CSAT_LOW_ROLE).map((item) => item.userId));
  }
}

/**
 * Уведомление правила: сотруднику или роли уведомление в портале и письмо, дежурным письмо на их адреса и сообщение
 * в служебный чат (те же входы, что у остальных уведомлений). Дежурным уходят только номер и название правила:
 * темы обращения там нет, это текст клиента (решение 0041).
 */
async function notify(c: ActionContext, tx: Tx, target: Extract<RuleAction, { action: 'notify' }>['target']): Promise<RuleActionResult> {
  const { ticket, snapshot, rule } = c;
  const url = `/agent/tickets/SUP-${ticket.number}`;
  if (target.kind === 'oncall') {
    const payload = { template: 'oncall_rule' as const, rule: rule.name, number: ticket.number, url };
    for (const channel of ['email', 'telegram'] as const) await enqueueTx(tx, { channel, recipient: { kind: 'oncall' }, template: 'oncall_rule', payload, ticketId: ticket.ticketId, locale: 'ru' });
    return { ok: true, to: 'oncall' };
  }
  const roster = await c.roster();
  const recipients = target.kind === 'user' ? roster.filter((item) => item.userId === target.userId) : roster.filter((item) => item.role === target.role);
  if (recipients.length === 0) return { ok: false, detail: target.kind === 'user' ? 'user_missing' : 'no_recipients' };
  const locale = (['ru', 'uz', 'en'] as const).find((item) => item === snapshot.locale) ?? 'ru';
  for (const member of recipients) {
    await notifyTx(tx, { userId: member.userId, kind: 'rule', ticketId: ticket.ticketId, orgId: ticket.orgId, payload: { number: ticket.number, title: snapshot.title, rule: rule.name } });
    await enqueueTx(tx, {
      channel: 'email',
      recipient: { kind: 'user', userId: member.userId },
      template: 'staff_rule',
      payload: { template: 'staff_rule', rule: rule.name, number: ticket.number, title: snapshot.title, url },
      ticketId: ticket.ticketId,
      locale,
    });
  }
  return { ok: true, to: target.kind === 'user' ? (recipients[0]?.name ?? null) : target.role };
}

const BUILTIN_ACTION_SET: ReadonlySet<string> = new Set(BUILTIN_ACTIONS);

/** Код SQLSTATE ошибки базы: драйвер кладёт его в поле code, Drizzle оборачивает ошибку драйвера в cause. */
function sqlState(error: unknown): string | null {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * Ошибка, которую повтор не исправит: отказ модуля с кодом (HdtError, HdwError) или отказ базы по данным и правам:
 * классы SQLSTATE 22 (неверное значение), 23 (нарушение ограничения) и 42 (нет прав, политика RLS). Всё остальное
 * (обрыв подключения, в том числе к таблицам идентичности, взаимная блокировка, отмена запроса) считается временным.
 */
export function isPermanentFailure(error: unknown): boolean {
  if (isHdtError(error) || isHdwError(error)) return true;
  const state = sqlState(error);
  return state !== null && ['22', '23', '42'].includes(state.slice(0, 2));
}

/**
 * Выполняет одно действие в точке сохранения. Ожидаемый отказ (переход запрещён, тега нет) действие возвращает
 * кодом. Ошибка, которую повтор не исправит (isPermanentFailure), откатывает только это действие и записывается
 * отказом с кодом error: остальные действия идут дальше. error: true значит, что состояние обращения в памяти могло
 * разойтись с базой и его нужно перечитать.
 *
 * Остальные ошибки бросаются дальше (проверка вехи M8, находка C1): транзакция события откатывается, событие
 * остаётся в очереди и разбирается снова с паузой. Иначе короткий обрыв подключения записывался бы отказом, событие
 * получало отметку разбора, и сообщение дежурным о P1 терялось без следа. Два уточнения:
 * - уведомление предустановленного правила бросает любую ошибку, и на последней попытке тоже: событие снимается с
 *   очереди, и дежурные получают сигнал "событие не разобрано" (ops.watch);
 * - обычное действие на последней попытке (lastAttempt) записывается отказом: один сбойный вебхук или тег не должен
 *   снять событие вместе с уведомлениями остальных правил.
 */
export async function executeAction(c: ActionContext, action: RuleAction): Promise<ActionDone & { error?: true }> {
  try {
    return report(action.action, await c.tx.transaction((point) => run(c, point, action)));
  } catch (error) {
    const retry = BUILTIN_ACTION_SET.has(action.action) || (!c.lastAttempt && !isPermanentFailure(error));
    // Вид ошибки без её текста: в тексте могут быть данные клиента.
    logEvent(retry ? 'warn' : 'error', retry ? 'automation.action_retry' : 'automation.action_failed', { ruleId: c.rule.ruleId, ticketId: c.ticket.ticketId, action: action.action, error: error instanceof Error ? error.name : 'ошибка' });
    if (retry) throw error;
    return { action: action.action, ok: false, detail: 'error', error: true };
  }
}

// --- Пробный прогон: что действие сделало бы, без записи ---

export type DryRunRefs = { roster: readonly StaffMember[]; tags: Map<string, Tag>; templates: Map<string, ReplyTemplate>; endpoints: Map<string, { name: string; isEnabled: boolean }> };

/** Справочники для описания действий правила в пробном прогоне: теги, шаблоны и адреса вебхуков, на которые правило ссылается. */
export async function dryRunRefsTx(tx: Tx, actions: readonly RuleAction[], roster: readonly StaffMember[]): Promise<DryRunRefs> {
  const tagIds = actions.flatMap((item) => (item.action === 'add_tag' || item.action === 'remove_tag' ? [item.tagId] : []));
  const templateIds = actions.flatMap((item) => (item.action === 'reply_template' ? [item.templateId] : []));
  const endpointIds = actions.flatMap((item) => (item.action === 'webhook' ? [item.endpointId] : []));
  return { roster, tags: await tagsByIdTx(tx, tagIds), templates: await templatesByIdTx(tx, templateIds), endpoints: await endpointsByIdTx(tx, endpointIds) };
}

/**
 * Что действие сделало бы с обращением в его текущем состоянии (FR-AUTO-08): прежнее и новое значение или причина
 * отказа. Ничего не читает и не пишет. Каждое действие описано от текущего состояния обращения: изменения
 * предыдущих действий того же правила в описании не учтены. Исполнителя "по кругу" выбирает само срабатывание.
 */
export function describeAction(action: RuleAction, snapshot: TicketSnapshot, refs: DryRunRefs, now: Date): ActionDone {
  const name = (userId: string | null) => (userId ? (refs.roster.find((item) => item.userId === userId)?.name ?? null) : null);
  const settled = snapshot.status === 'resolved' || snapshot.status === 'closed';
  const same = (value: string | null): ActionDone => ({ action: action.action, ok: true, from: value, to: value, unchanged: true });
  const fail = (detail: string): ActionDone => ({ action: action.action, ok: false, detail });
  switch (action.action) {
    case 'set_queue':
      if (snapshot.queue === action.queue) return same(action.queue);
      if (settled || (snapshot.queue === 'l1' && !TRANSFERABLE_STATUSES.includes(snapshot.status)) || (action.queue === 'l1' && snapshot.status === 'in_development')) return fail('transition_refused');
      return { action: action.action, ok: true, from: snapshot.queue, to: action.queue };
    case 'assign': {
      const member = refs.roster.find((item) => item.userId === action.userId && WRITER_ROLES.includes(item.role));
      if (!member) return fail('user_missing');
      if (snapshot.assigneeId === member.userId) return same(member.name);
      return { action: action.action, ok: true, from: name(snapshot.assigneeId), to: member.name };
    }
    case 'assign_round_robin': {
      const candidates = lineCandidates(refs.roster, snapshot.queue);
      if (candidates.length === 0) return fail('no_candidates');
      const current = candidates.find((item) => item.userId === snapshot.assigneeId);
      return current ? same(current.name) : { action: action.action, ok: true, from: name(snapshot.assigneeId), to: null };
    }
    case 'set_priority':
      return snapshot.priority === action.priority ? same(action.priority) : { action: action.action, ok: true, from: snapshot.priority, to: action.priority };
    case 'add_tag': {
      const tag = refs.tags.get(action.tagId);
      if (!tag) return fail('tag_missing');
      return snapshot.tagIds.includes(tag.tagId) ? same(tag.name) : { action: action.action, ok: true, from: null, to: tag.name };
    }
    case 'remove_tag': {
      const tag = refs.tags.get(action.tagId);
      if (!tag) return fail('tag_missing');
      return snapshot.tagIds.includes(tag.tagId) ? { action: action.action, ok: true, from: tag.name, to: null } : same(null);
    }
    case 'add_note':
      return { action: action.action, ok: true };
    case 'reply_template': {
      const template = refs.templates.get(action.templateId);
      if (!template) return fail('template_missing');
      if (!template.isEnabled) return fail('template_disabled');
      return { action: action.action, ok: true, to: template.title };
    }
    case 'notify': {
      if (action.target.kind === 'oncall') return { action: action.action, ok: true, to: 'oncall' };
      const target = action.target;
      const recipients = target.kind === 'user' ? refs.roster.filter((item) => item.userId === target.userId) : refs.roster.filter((item) => item.role === target.role);
      if (recipients.length === 0) return fail(target.kind === 'user' ? 'user_missing' : 'no_recipients');
      return { action: action.action, ok: true, to: target.kind === 'user' ? (recipients[0]?.name ?? null) : target.role };
    }
    case 'snooze':
      return settled ? fail('transition_refused') : { action: action.action, ok: true, from: null, to: new Date(now.getTime() + action.hours * HOUR_MS).toISOString() };
    case 'set_status':
      if (snapshot.status === action.status) return same(action.status);
      return canTransition(snapshot.status, action.status) ? { action: action.action, ok: true, from: snapshot.status, to: action.status } : fail('transition_refused');
    case 'webhook': {
      const endpoint = refs.endpoints.get(action.endpointId);
      if (!endpoint) return fail('endpoint_missing');
      return endpoint.isEnabled ? { action: action.action, ok: true, to: endpoint.name } : fail('endpoint_disabled');
    }
    case 'link_known_problem':
      return snapshot.knownProblemId ? fail('already_linked') : { action: action.action, ok: true, from: null, to: `KP-${action.problemNumber}` };
    // Пробный прогон запроса не создаёт: показывает, что анализ был бы запрошен.
    case 'request_code_analysis':
      return { action: action.action, ok: true };
    // Уведомления предустановленных правил. Однократность сообщения дежурным и то, какой срок нарушен, знает только
    // само срабатывание: прогон показывает, что уведомление было бы отправлено.
    case 'notify_oncall_p1':
      return snapshot.priority === 'p1' ? { action: action.action, ok: true, to: 'oncall' } : same(null);
    case 'notify_sla_breach':
      return { action: action.action, ok: true };
    case 'notify_csat_low':
      if (snapshot.rating === null || snapshot.rating > 2) return fail('not_low_rating');
      return refs.roster.some((item) => item.role === CSAT_LOW_ROLE) ? { action: action.action, ok: true, to: String(snapshot.rating) } : fail('no_recipients');
  }
}
