import { createHash, randomBytes } from 'node:crypto';
import type { AgentActor } from '@/db/with-actor';
import type { AgentTool } from '@/modules/hda/pref';
import { pools } from './db';

// Учётная запись AI-сотрудника и токены напрямую в базу (веха M8b): подготовка данных суперпользователем.

let serial = 0;

/** Учётная запись agent_bot: строка auth."user" и строка hdu_staff. */
export async function seedAgentBot(name = 'AI-сотрудник: Hermes'): Promise<string> {
  serial += 1;
  const user = await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ($1, $2, false) returning id`, [
    name,
    `agent-bot-${serial}-${Date.now()}@users.invalid`,
  ]);
  const userId = user.rows[0].id as string;
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, 'agent_bot')`, [userId]);
  return userId;
}

export type SeedToken = {
  userId?: string;
  name?: string;
  tools?: AgentTool[];
  allowedIps?: string[];
  expiresIn?: string;
  revoked?: boolean;
  parentTokenId?: string;
  ticketId?: string;
  isEventParent?: boolean;
};

export type SeededToken = { tokenId: string; userId: string; value: string; actor: AgentActor };

/** Токен агента. По умолчанию основной, действует сутки, все адреса сети 10.0.0.0/8. */
export async function seedAgentToken(input: SeedToken = {}): Promise<SeededToken> {
  const userId = input.userId ?? (await seedAgentBot());
  const value = `hub_at_${randomBytes(32).toString('base64url')}`;
  const tools: AgentTool[] = input.tools ?? (input.ticketId ? ['get_ticket', 'add_internal_note'] : ['search_tickets', 'get_ticket', 'add_internal_note', 'create_report']);
  const r = await pools.root.query(
    `insert into hda_agent_tokens (name, staff_user_id, token_hash, token_last4, tools, allowed_ips, expires_at, revoked_at,
                                   parent_token_id, ticket_id, note_limit, is_event_parent)
     values ($1, $2, $3, $4, $5, $6::cidr[], now() + $7::interval, case when $8 then now() end, $9, $10, $11, $12) returning token_id`,
    [
      input.name ?? 'Hermes: поддержка',
      userId,
      createHash('sha256').update(value).digest('hex'),
      value.slice(-4),
      tools,
      input.allowedIps ?? ['10.0.0.0/8'],
      input.expiresIn ?? '1 day',
      input.revoked ?? false,
      input.parentTokenId ?? null,
      input.ticketId ?? null,
      input.ticketId ? 1 : null,
      input.isEventParent ?? false,
    ],
  );
  const tokenId = r.rows[0].token_id as string;
  return { tokenId, userId, value, actor: { type: 'agent', tokenId, userId, tools, ticketId: input.ticketId ?? null } };
}
