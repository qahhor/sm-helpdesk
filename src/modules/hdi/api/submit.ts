import 'server-only';
import { withActor } from '@/db/with-actor';
import { consumeRateLimit, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { findInText, type FindingKind } from '@/modules/hdk/api/text-checks';
import { isActiveModule } from '@/modules/hdr/api';
import type { ClientContext } from '@/modules/hdu/api';
import { createIdeaTx, editOwnIdeaTx, setShowOrgTx } from '../core/ideas';
import { HdiError } from '../error';
import { editInput, parseInput, showOrgInput, submitInput } from '../input';

// Модуль hdi, слой api: подача идеи и правка автором (ТЗ FR-IDEA-01, 06, 14.5; план M7, задача 2, решения 4, 5, 7,
// 9, 20). Автор и организация берутся из актора; имя и название организации снимком из контекста сессии, база
// сверяет их с профилем и карточкой организации. Находки проверки текста (телефон, email, ИНН, ПИНФЛ, адрес сервера,
// внутренние имена) не отказ, а предупреждение: клиент видит его и может отправить всё равно (решение 9).

export type SubmitResult = { status: 'confirm'; findings: FindingKind[] } | { status: 'submitted'; number: number };

/** Виды находок в заголовке и описании без повторов, в порядке появления. */
export function ideaFindings(title: string, body: string): FindingKind[] {
  return [...new Set([...findInText(title), ...findInText(body)].map((hit) => hit.kind))];
}

async function requireModule(ctx: Pick<ClientContext, 'actor'>, moduleId: string | null): Promise<void> {
  if (moduleId && !(await isActiveModule(ctx.actor, moduleId))) throw new HdiError('invalid_input');
}

export async function submitIdea(ctx: Pick<ClientContext, 'actor' | 'user' | 'org'>, input: unknown): Promise<SubmitResult> {
  const data = parseInput(submitInput, input);
  const findings = ideaFindings(data.title, data.body);
  if (findings.length > 0 && !data.confirmFindings) return { status: 'confirm', findings };
  await requireModule(ctx, data.moduleId);
  // Предел считает только настоящие подачи: показ предупреждения его не расходует (5 в сутки, раздел 14.5).
  const limit = await consumeRateLimit(rateKey('idea-create:user', ctx.actor.userId), RATE_RULES.ideaCreatePerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  const { number } = await withActor(ctx.actor, (tx) =>
    createIdeaTx(tx, ctx.actor, { ...data, authorName: ctx.user.name, orgName: ctx.org.name, findings }),
  );
  return { status: 'submitted', number };
}

/** Правка своей идеи, пока она на модерации (решение 5). После публикации: not_editable. */
export async function editOwnIdea(ctx: Pick<ClientContext, 'actor' | 'org'>, input: unknown): Promise<{ findings: FindingKind[] }> {
  const data = parseInput(editInput, input);
  await requireModule(ctx, data.moduleId);
  const limit = await consumeRateLimit(rateKey('idea-edit:user', ctx.actor.userId), RATE_RULES.ideaEditPerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  await withActor(ctx.actor, (tx) => editOwnIdeaTx(tx, ctx.actor, data.number, { ...data, orgName: ctx.org.name }));
  return { findings: ideaFindings(data.title, data.body) };
}

/** "Показывать мою организацию" у своей идеи в любом статусе (FR-IDEA-06, решение 7). */
export async function setIdeaShowOrg(ctx: Pick<ClientContext, 'actor' | 'org'>, input: unknown): Promise<void> {
  const data = parseInput(showOrgInput, input);
  const limit = await consumeRateLimit(rateKey('idea-edit:user', ctx.actor.userId), RATE_RULES.ideaEditPerUser);
  if (!limit.allowed) throw new HdiError('rate_limited', { retryAfterSec: limit.retryAfterSec });
  await withActor(ctx.actor, (tx) => setShowOrgTx(tx, ctx.actor, data.number, data.showOrg, ctx.org.name));
}
