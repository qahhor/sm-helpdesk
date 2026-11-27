import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import type { SystemActor } from '@/db/with-actor';
import { AGENT_RUN_TOOLS } from '../pref';
import { agentTokens } from '../schema';
import { generateTokenValue, hashToken, tokenLast4 } from './auth';

// Токен запуска по обращению (веха M8b, задача 7; FR-AGT-12, T35, поправка 101; план M8b, решения 15, 27). Выпускает
// система в транзакции отправки события агенту: перечень ровно get_ticket и add_internal_note, одна заметка, срок
// 2 часа, адреса и учётная запись основного токена. Значение уходит только в теле подписанного события, в базе
// хеш. Повторный выпуск по тому же обращению отзывает прежний токен запуска. Отзыв основного токена закрывает все его
// токены запуска сразу: функция базы app.agent_token_active() проверяет и родителя.

export const RUN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const RUN_NOTE_LIMIT = 1;

export type RunToken = { tokenId: string; value: string; expiresAt: Date };

export async function issueTicketRunTokenTx(tx: Tx, system: SystemActor, input: { parentTokenId: string; ticketId: string }, now: Date = new Date()): Promise<RunToken> {
  if (system.type !== 'system') throw new Error('Токен запуска выпускает только система');
  const [parent] = await tx
    .select({ tokenId: agentTokens.tokenId, name: agentTokens.name, userId: agentTokens.staffUserId, allowedIps: agentTokens.allowedIps, dailyLimit: agentTokens.dailyLimit })
    .from(agentTokens)
    .where(and(eq(agentTokens.tokenId, input.parentTokenId), isNull(agentTokens.parentTokenId), isNull(agentTokens.revokedAt)))
    .limit(1);
  if (!parent) throw new Error('Токен запуска: основной токен не найден или отозван');
  // Прежние токены запуска того же основного токена и обращения перестают действовать.
  await tx
    .update(agentTokens)
    .set({ revokedAt: now })
    .where(and(eq(agentTokens.parentTokenId, parent.tokenId), eq(agentTokens.ticketId, input.ticketId), isNull(agentTokens.revokedAt)));
  const value = generateTokenValue();
  const tokenId = randomUUID();
  const expiresAt = new Date(now.getTime() + RUN_TOKEN_TTL_MS);
  await tx.insert(agentTokens).values({
    tokenId,
    name: parent.name,
    staffUserId: parent.userId,
    tokenHash: hashToken(value),
    tokenLast4: tokenLast4(value),
    tools: [...AGENT_RUN_TOOLS],
    allowedIps: parent.allowedIps,
    expiresAt,
    dailyLimit: parent.dailyLimit,
    parentTokenId: parent.tokenId,
    ticketId: input.ticketId,
    noteLimit: RUN_NOTE_LIMIT,
  });
  return { tokenId, value, expiresAt };
}

/** Отозвать токен запуска (например, если событие с ним не ушло). Основной токен так не отзывается. */
export async function revokeTicketRunTokenTx(tx: Tx, system: SystemActor, input: { tokenId: string }, now: Date = new Date()): Promise<void> {
  if (system.type !== 'system') throw new Error('Токен запуска отзывает только система');
  await tx
    .update(agentTokens)
    .set({ revokedAt: now })
    .where(and(eq(agentTokens.tokenId, input.tokenId), isNotNull(agentTokens.parentTokenId), isNull(agentTokens.revokedAt)));
}
