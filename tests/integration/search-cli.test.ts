import { beforeEach, describe, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { pools } from './helpers/db';
import { liveSearch, resetTypesense, typesenseMasterKey, typesenseSkip, typesenseUrl } from './helpers/search';
import { seedTwoOrgs } from './isolation/fixture';

// Команды hub search:* на настоящем Typesense (план W6, задачи 2-4): ключи процессов с аудитом без значений.

function fakeIo(env: Record<string, string | undefined>, secret = '') {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { env: { ...process.env, ...env }, out: (l: string) => void lines.push(l), err: (l: string) => void errors.push(l), readSecret: async () => secret } };
}

const keyOf = (lines: string[], name: string) => lines.find((l) => l.includes(`${name}=`))?.split(`${name}=`)[1] ?? '';

describe.skipIf(typesenseSkip !== null)(`hub search:keys${typesenseSkip ? ` (пропущено: ${typesenseSkip})` : ''}`, () => {
  beforeEach(resetTypesense);

  test('создаёт три ключа, печатает их один раз, аудит без значений; --rotate гасит прежние', async () => {
    const first = fakeIo({ TYPESENSE_URL: typesenseUrl, TYPESENSE_API_KEY: undefined }, typesenseMasterKey);
    expect(await runCli(['search:keys'], first.io)).toBe(0);
    const write = keyOf(first.lines, 'TYPESENSE_WRITE_KEY');
    const search = keyOf(first.lines, 'TYPESENSE_SEARCH_KEY');
    expect(write.length).toBeGreaterThan(16);
    expect(search.length).toBeGreaterThan(16);
    expect(keyOf(first.lines, 'TYPESENSE_STAFF_SEARCH_KEY')).not.toBe(search);
    const audit = (await pools.root.query(`select actor_type, diff from hdc_audit_log where action = 'search.keys_created'`)).rows;
    expect(audit).toEqual([{ actor_type: 'system', diff: { processes: ['client_search', 'staff_search', 'write'], rotated: false, removed: 0 } }]);
    expect(JSON.stringify(audit)).not.toContain(write);

    const second = fakeIo({ TYPESENSE_URL: typesenseUrl, TYPESENSE_API_KEY: typesenseMasterKey });
    expect(await runCli(['search:keys', '--rotate'], second.io)).toBe(0);
    expect(second.lines.join('\n')).toContain('Прежних ключей удалено: 3');
    const old = await fetch(`${typesenseUrl}/collections`, { headers: { 'x-typesense-api-key': write } });
    expect(old.status).toBe(401);
    const fresh = await fetch(`${typesenseUrl}/collections`, { headers: { 'x-typesense-api-key': keyOf(second.lines, 'TYPESENSE_WRITE_KEY') } });
    expect(fresh.status).toBe(200);
  });

  test('search:reindex строит все коллекции, search:status показывает документы и очередь', async () => {
    const f = await seedTwoOrgs();
    const live = await liveSearch();
    const env = { SEARCH_PROVIDER: 'typesense', TYPESENSE_URL: typesenseUrl, TYPESENSE_WRITE_KEY: live.keys.write };
    const run = fakeIo(env);
    expect(await runCli(['search:reindex'], run.io), run.errors.join('\n')).toBe(0);
    expect(run.lines).toContain('tickets: построена hub_tickets_v2, документов 5.');
    expect(run.lines.find((l) => l.startsWith('ticket_texts:'))).toMatch(/документов 10\.$/);
    const status = fakeIo(env);
    expect(await runCli(['search:status'], status.io)).toBe(0);
    expect(status.lines).toContain('Typesense: отвечает.');
    expect(status.lines).toContain('tickets: hub_tickets_v2, документов 5.');
    expect(status.lines.join('\n')).not.toContain(live.keys.write);
    expect(status.lines.join('\n')).not.toContain(f.tickets.aOrg.title);
    const bad = fakeIo(env);
    expect(await runCli(['search:reindex', '--collection', 'secrets'], bad.io)).toBe(2);
    const off = fakeIo({ SEARCH_PROVIDER: 'postgres' });
    expect(await runCli(['search:reindex'], off.io)).toBe(2);
  });

  test('без адреса: неверный вызов, ничего не создаётся', async () => {
    const run = fakeIo({ TYPESENSE_URL: undefined, TYPESENSE_API_KEY: typesenseMasterKey });
    expect(await runCli(['search:keys'], run.io)).toBe(2);
    expect(run.errors.join('\n')).toContain('TYPESENSE_URL');
  });
});
