import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Чек-лист ASVS 5.0.0 уровня 2 (план подготовки M9, задача 1, решение 3): docs/security/asvs.md. Строка на каждое
// требование уровней 1 и 2 из docs/security/asvs-5.0.0-l1-l2.csv (выборка из официального файла OWASP), у каждой
// состояние, у выполненного доказательство, у невыполненного шаг. Каждый путь в доказательствах существует.

const STATES = new Set(['есть', 'частично', 'нет', 'не применимо']);
const PATH = /^(?:(?:src|tests|docs|scripts|drizzle|messages|content|public)\/[^\s`]+|Caddyfile|Dockerfile|compose\.prod\.yaml|next\.config\.ts|\.env\.example|playwright\.config\.ts)$/;

type Row = { id: string; level: string; state: string; evidence: string; action: string };

function rows(): Row[] {
  return readFileSync('docs/security/asvs.md', 'utf8')
    .split('\n')
    .filter((line) => /^\| V\d+\.\d+\.\d+ \|/.test(line))
    .map((line) => {
      const cells = line.slice(1, -1).split(' | ').map((cell) => cell.trim());
      return { id: cells[0] ?? '', level: cells[1] ?? '', state: cells[3] ?? '', evidence: cells[4] ?? '', action: cells[5] ?? '' };
    });
}

function official(): { id: string; level: string }[] {
  return readFileSync('docs/security/asvs-5.0.0-l1-l2.csv', 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [id, level] = line.split(',');
      return { id: id ?? '', level: level ?? '' };
    });
}

test('выборка стандарта: 253 требования уровней 1 и 2, номера не повторяются', () => {
  const list = official();
  expect(list).toHaveLength(253);
  expect(new Set(list.map((r) => r.id)).size).toBe(253);
  expect(list.every((r) => r.level === '1' || r.level === '2')).toBe(true);
});

test('в чек-листе каждое требование выборки ровно один раз, в том же порядке и с тем же уровнем', () => {
  expect(rows().map((r) => `${r.id} ${r.level}`)).toEqual(official().map((r) => `${r.id} ${r.level}`));
});

test('у каждой строки состояние из списка, у выполненного доказательство, у невыполненного шаг', () => {
  for (const row of rows()) {
    expect(STATES.has(row.state), `${row.id}: ${row.state}`).toBe(true);
    if (row.state === 'есть' || row.state === 'частично') expect(row.evidence, row.id).not.toBe('');
    if (row.state === 'частично' || row.state === 'нет') expect(row.action, row.id).not.toBe('');
  }
});

test('каждый путь в столбце доказательств существует', () => {
  const missing: string[] = [];
  let paths = 0;
  for (const row of rows())
    for (const [, token] of row.evidence.matchAll(/`([^`]+)`/g)) {
      if (!token || !PATH.test(token)) continue;
      paths++;
      if (!existsSync(token)) missing.push(`${row.id}: ${token}`);
    }
  expect(missing).toEqual([]);
  expect(paths).toBeGreaterThan(300);
});

test('отклонения собраны в конце файла: каждое требование "нет" и "частично" названо там с тем, кто решает', () => {
  const text = readFileSync('docs/security/asvs.md', 'utf8');
  const section = text.slice(text.indexOf('## Отклонения'));
  expect(section.length).toBeGreaterThan(100);
  const open = rows().filter((r) => r.state === 'нет' || r.state === 'частично').map((r) => r.id);
  expect(open.length).toBeGreaterThan(0);
  // Номер стоит в разделе отдельным словом: V12.1.1 не засчитывается строкой V12.1.10.
  for (const id of open) expect(section, id).toMatch(new RegExp(`${id.replaceAll('.', '\\.')}(?![0-9])`));
});
