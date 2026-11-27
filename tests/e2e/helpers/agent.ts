import { createHash, randomBytes } from 'node:crypto';
import { createMcpClient } from '../../helpers/mcp-client';
import { dbRows } from './db';

// AI-сотрудник для браузерных тестов (веха M8b): учётная запись agent_bot и токен прямо в базу, вызовы сервера MCP
// тестовым клиентом по HTTP (решение 32 плана M8b). Адрес запроса 127.0.0.1: так его видит портал без CLIENT_IP_HEADER.

const BASE_URL = `http://localhost:${process.env.PORT ?? 3100}`;

export async function seedAgentForE2e(tools: string[]): Promise<{ tokenId: string; userId: string; value: string }> {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const [user] = await dbRows<{ id: string }>(`insert into auth."user" (name, email, "emailVerified") values ($1, $2, false) returning id`, [
    `AI-сотрудник: E2E ${stamp}`,
    `agent-bot-e2e-${stamp}@users.invalid`,
  ]);
  await dbRows(`insert into hdu_staff (user_id, role) values ($1, 'agent_bot')`, [user!.id]);
  const value = `hub_at_${randomBytes(32).toString('base64url')}`;
  const [token] = await dbRows<{ token_id: string }>(
    `insert into hda_agent_tokens (name, staff_user_id, token_hash, token_last4, tools, allowed_ips, expires_at)
     values ($1, $2, $3, $4, $5, '{127.0.0.0/8,::1/128}'::cidr[], now() + interval '1 day') returning token_id`,
    [`E2E ${stamp}`, user!.id, createHash('sha256').update(value).digest('hex'), value.slice(-4), tools],
  );
  return { tokenId: token!.token_id, userId: user!.id, value };
}

export function e2eMcpClient(token: string) {
  return createMcpClient({ token, ip: '127.0.0.1', url: `${BASE_URL}/api/mcp`, send: (request) => fetch(request) });
}

/** Результат инструмента или ошибка теста с кодом отказа. */
export async function callOk(client: ReturnType<typeof e2eMcpClient>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool(name, args);
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
  return result.structuredContent ?? {};
}
