import { beforeEach, describe, expect, test } from 'vitest';
import { runCli } from '@/cli/commands';
import { pools } from './helpers/db';
import { resetTypesense, typesenseMasterKey, typesenseSkip, typesenseUrl } from './helpers/search';

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

  test('без адреса: неверный вызов, ничего не создаётся', async () => {
    const run = fakeIo({ TYPESENSE_URL: undefined, TYPESENSE_API_KEY: typesenseMasterKey });
    expect(await runCli(['search:keys'], run.io)).toBe(2);
    expect(run.errors.join('\n')).toContain('TYPESENSE_URL');
  });
});
