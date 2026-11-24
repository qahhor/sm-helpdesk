import 'server-only';
import { type StaffActor, withActor } from '@/db/with-actor';
import { tagsByIdTx, templatesByIdTx } from '@/modules/hdr/api';
import { staffRoster } from '@/modules/hdu/api/automation';
import type { MacroAction } from '../macro-schema';
import type { RuleAction, RuleIssue } from '../rule-schema';
import { endpointsByIdTx } from './webhooks';

// Модуль hdw, слой core: ссылки действий правила и макроса на справочники (план M8, задачи 3, 5 и 6). Проверяются
// при сохранении: тег, шаблон, сотрудник и адрес вебхука должны существовать. Ссылка, которая исчезла позже,
// при выполнении даёт отказ действия с кодом, а не сбой.

/** Сотрудники, которые ведут обращения: исполнителем становится только такой (ТЗ 5.2: не product). */
export const WRITER_ROLES: readonly string[] = ['agent_l1', 'agent_l2', 'care', 'admin'];

/**
 * Действия со ссылками, которых нет в справочниках. Путь отказа: actions.<номер>.<поле>. Адрес вебхука должен быть
 * в списке администратора (FR-AUTO-10); выключенный адрес и выключенный шаблон допускаются, действие с ними
 * запишется невыполненным.
 */
export async function missingActionRefs(actor: StaffActor, actions: readonly (RuleAction | MacroAction)[]): Promise<RuleIssue[]> {
  const issues: RuleIssue[] = [];
  const missing = (path: string) => issues.push({ path, code: 'reference_missing' });
  const tagActions = actions.flatMap((item, index) => (item.action === 'add_tag' || item.action === 'remove_tag' ? [{ index, value: item.tagId }] : []));
  const templateActions = actions.flatMap((item, index) => (item.action === 'reply_template' ? [{ index, value: item.templateId }] : []));
  const webhookActions = actions.flatMap((item, index) => (item.action === 'webhook' ? [{ index, value: item.endpointId }] : []));
  if (tagActions.length + templateActions.length + webhookActions.length > 0) {
    const found = await withActor(actor, async (tx) => ({
      tags: await tagsByIdTx(tx, tagActions.map((ref) => ref.value)),
      templates: await templatesByIdTx(tx, templateActions.map((ref) => ref.value)),
      endpoints: await endpointsByIdTx(tx, webhookActions.map((ref) => ref.value)),
    }));
    for (const ref of tagActions) if (!found.tags.has(ref.value)) missing(`actions.${ref.index}.tagId`);
    for (const ref of templateActions) if (!found.templates.has(ref.value)) missing(`actions.${ref.index}.templateId`);
    for (const ref of webhookActions) if (!found.endpoints.has(ref.value)) missing(`actions.${ref.index}.endpointId`);
  }
  if (actions.some((item) => item.action === 'assign' || (item.action === 'notify' && item.target.kind === 'user'))) {
    const roster = await staffRoster();
    for (const [index, item] of actions.entries()) {
      // Исполнителем становится только сотрудник, который ведёт обращения; уведомить можно любого действующего.
      if (item.action === 'assign' && !roster.some((member) => member.userId === item.userId && WRITER_ROLES.includes(member.role))) missing(`actions.${index}.userId`);
      if (item.action === 'notify' && item.target.kind === 'user') {
        const userId = item.target.userId;
        if (!roster.some((member) => member.userId === userId)) missing(`actions.${index}.target.userId`);
      }
    }
  }
  return issues;
}
