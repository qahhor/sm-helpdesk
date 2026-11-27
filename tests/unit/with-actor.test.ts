import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { expect, test } from 'vitest';
import type { AppDb } from '@/db/client';
import { type Actor, createWithActor } from '@/db/with-actor';

// Переменные транзакции, которые withActor ставит для каждого вида актора (веха M8b, задача 1, решение 5).
// Запрос не уходит в базу: поддельное подключение собирает текст и значения первого запроса транзакции.

const dialect = new PgDialect();

async function settings(actor: Actor): Promise<Record<string, string>> {
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = { execute: async (query: SQL) => void queries.push(dialect.sqlToQuery(query)) };
  const db = { transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) } as unknown as AppDb;
  await createWithActor(db)(actor, async () => null);
  const result: Record<string, string> = {};
  for (const query of queries) {
    // set_config('имя', $n, true): имя в тексте, значение в параметре.
    const pattern = /set_config\('([a-z_.]+)', \$(\d+), true\)/g;
    for (const match of query.sql.matchAll(pattern)) result[match[1]!] = String(query.params[Number(match[2]) - 1]);
  }
  return result;
}

const agent: Actor = {
  type: 'agent',
  tokenId: '019a0000-0000-7000-8000-00000000a001',
  userId: '019a0000-0000-7000-8000-00000000b001',
  tools: ['get_ticket', 'add_internal_note'],
  ticketId: '019a0000-0000-7000-8000-00000000c001',
  ip: '10.0.3.12',
};

test('актор agent ставит вид, учётную запись, токен, обращение и адрес', async () => {
  const values = await settings(agent);
  expect(values).toMatchObject({
    'app.actor_type': 'agent',
    'app.user_id': '019a0000-0000-7000-8000-00000000b001',
    'app.agent_token_id': '019a0000-0000-7000-8000-00000000a001',
    'app.agent_ticket_id': '019a0000-0000-7000-8000-00000000c001',
    'app.client_ip': '10.0.3.12',
    'app.org_id': '',
    'app.staff_role': '',
  });
});

test('основной токен агента не задаёт обращения', async () => {
  const values = await settings({ ...agent, ticketId: null });
  expect(values['app.agent_ticket_id']).toBe('');
  expect(values['app.agent_token_id']).toBe('019a0000-0000-7000-8000-00000000a001');
});

test('транзакция агента ограничена по времени запроса (решение 31)', async () => {
  expect((await settings(agent))['statement_timeout']).toBe('5s');
});

test('у остальных акторов переменные агента пусты и предел времени не меняется', async () => {
  for (const actor of [
    { type: 'staff', userId: 'staff-1', staffRole: 'admin' },
    { type: 'client', userId: 'client-1', orgId: '019a1111-1111-7111-8111-111111111111', orgRole: 'client_user' },
    { type: 'system', job: 'test' },
  ] as Actor[]) {
    const values = await settings(actor);
    expect(values['app.agent_token_id'], actor.type).toBe('');
    expect(values['app.agent_ticket_id'], actor.type).toBe('');
    expect(values['statement_timeout'], actor.type).toBeUndefined();
  }
});
