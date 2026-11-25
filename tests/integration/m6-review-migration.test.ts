import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { migrate } from '../../scripts/db/migrate.mjs';
import { dropMigratedObjects, pools } from './helpers/db';

// Замечание I1 проверки M6: миграция 0078 заполняет издателя токена контекста у уже заведённых серверов, не снимая
// FORCE ROW LEVEL SECURITY. Проверка на базе, где серверы были до 0078 (как в базе браузерных тестов).

const SECRET = 'v1.aaaa.bbbb.cccc';

test('0078 на базе с серверами: издатель заполнен из адреса входа, принуждение RLS не снималось', async () => {
  await dropMigratedObjects();
  const before = mkdtempSync(join(tmpdir(), 'hub-migrations-'));
  for (const name of readdirSync('drizzle').filter((file) => file.endsWith('.sql') && file < '0078')) cpSync(join('drizzle', name), join(before, name));
  await migrate({ dir: before });
  await pools.root.query(
    `insert into hdu_servers (name, base_url, issuer, oauth_client_id, oauth_client_secret, code)
     values ('Старый', 'https://old.example.test', 'https://id.old.example.test', 'hub', $1, 'old-one'),
            ('Второй', 'https://two.example.test', 'https://id.two.example.test/realm', 'hub', $1, 'old-two')`,
    [SECRET],
  );
  try {
    await migrate();
    const rows = await pools.root.query(`select code, context_issuer from hdu_servers where code like 'old-%' order by code`);
    expect(rows.rows).toEqual([
      { code: 'old-one', context_issuer: 'https://id.old.example.test' },
      { code: 'old-two', context_issuer: 'https://id.two.example.test/realm' },
    ]);
    const force = await pools.owner.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.hdu_servers'::regclass`);
    expect(force.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  } finally {
    await pools.root.query(`delete from hdu_servers where code like 'old-%'`);
  }
});
