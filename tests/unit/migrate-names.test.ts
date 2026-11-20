import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { migrate } from '../../scripts/db/migrate.mjs';

test('файл миграции с неверным именем останавливает запуск, а не пропускается молча (ревью M11)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-migrations-'));
  writeFileSync(join(dir, '0001_ok.sql'), 'select 1;');
  writeFileSync(join(dir, '0003_add-index.sql'), 'select 1;');
  // Имена проверяются до подключения: адрес базы здесь заведомо нерабочий.
  await expect(migrate({ ownerUrl: 'postgres://hub_owner:x@127.0.0.1:1/hub', dir })).rejects.toThrow(/0003_add-index\.sql/);
});
