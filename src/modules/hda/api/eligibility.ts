import 'server-only';
import type { ClientActor, SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { orgAiProfile } from '@/modules/hdu/api/orgs';
import { activeCutoffTx, monthSpendTx } from '../core/runs';
import { aiConfig } from './config';

// Модуль hda, слой api: получит ли новое обращение помощника (план M5b, задача 3, решение 4). Вызывает модуль hdt
// при создании обращения от имени системы. Источник (портал, виджет, письмо опознанного пользователя с DMARC) решает
// hdt; здесь условия модуля AI: помощник включён администратором, AI-обработка организации включена, организация не
// отключена пределом расходов и месячный предел не исчерпан.

export async function assistantEligible(system: SystemActor, input: { orgId: string }): Promise<boolean> {
  const config = await aiConfig();
  if (!config.enabled) return false;
  const profile = await orgAiProfile(system, { orgId: input.orgId, userIds: [] });
  if (!profile?.isAiEnabled) return false;
  return withActor(system, async (tx) => (await activeCutoffTx(tx, input.orgId)) === null && (await monthSpendTx(tx)).total < config.monthlyBudgetUsd);
}

/** Разбор без ответа (решение 6): AI-обработка организации включена и предложения разбора включены администратором. */
export async function triageEligible(system: SystemActor, input: { orgId: string }): Promise<boolean> {
  const config = await aiConfig();
  if (!config.triageEnabled) return false;
  const profile = await orgAiProfile(system, { orgId: input.orgId, userIds: [] });
  return profile?.isAiEnabled === true;
}

/**
 * Ответит ли помощник первым на новое обращение клиента (FR-AI-19): подпись формы нового обращения. Организация
 * берётся из актора клиента, проверка идёт от имени системы.
 */
export async function assistantAnswersFirst(ctx: { actor: ClientActor }): Promise<boolean> {
  return assistantEligible({ type: 'system', job: 'ai.hint' }, { orgId: ctx.actor.orgId });
}
