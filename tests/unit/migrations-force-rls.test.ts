import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Снятие FORCE ROW LEVEL SECURITY в миграции требует отдельного согласования владельца (CLAUDE.md). Согласовано
// только для 0067 (заполнение предустановленных правил). Замечание I1 проверки M6: миграция 0078 снимала принуждение
// без согласования; заполнение колонки делается перезаписью таблицы (ALTER COLUMN ... TYPE ... USING), RLS её не касается.
const APPROVED = new Set(['0067_hdw_builtin_rules.sql']);

test('ни одна миграция, кроме согласованной 0067, не снимает FORCE ROW LEVEL SECURITY (проверка M6, I1)', () => {
  const offenders = readdirSync('drizzle')
    .filter((name) => name.endsWith('.sql') && !APPROVED.has(name))
    .filter((name) =>
      readFileSync(`drizzle/${name}`, 'utf8')
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .some((line) => /NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(line)),
    );
  expect(offenders).toEqual([]);
});
