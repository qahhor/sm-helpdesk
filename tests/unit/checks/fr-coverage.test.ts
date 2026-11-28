import { expect, test } from 'vitest';
import { coverageViolations, frCodes, frCoverageCheck } from '../../../scripts/checks/fr-coverage.mjs';

// Перечень требований раздела 7 (план M9, задача 1, решение 21): каждый код FR из ТЗ есть в перечне, в перечне нет
// чужих кодов, "сделано" ссылается на тест, "перенесено" на решение, каждая ссылка ведёт на существующий файл.

const TZ = [
  '## 6. Сценарии',
  '| FR-OLD-01 | вне раздела 7 |',
  '## 7. Функциональные требования этапа 1',
  '### 7.1 Вход',
  '| FR-ID-01 | Вход. |',
  '| FR-ID-02 | Реестр, см. FR-ID-01. |',
  '### 7.2 Обращения',
  '| FR-TK-01 | Создание. |',
  '## 8. Как это должно выглядеть',
  '| FR-UX-01 | вне раздела 7 |',
].join('\n');

const FILES = new Set(['tests/integration/sso-flow.test.ts', 'tests/e2e/tickets.spec.ts', 'docs/decisions/0043-preset-rules.md']);
const exists = (path: string) => FILES.has(path);

const LIST = [
  '| Код | Состояние | Доказательство | Что ждёт или решение |',
  '|---|---|---|---|',
  '| FR-ID-01 | сделано на заглушке | `tests/integration/sso-flow.test.ts` | Регистрация портала |',
  '| FR-ID-02 | сделано | `tests/integration/sso-flow.test.ts` | |',
  '| FR-TK-01 | сделано | `tests/e2e/tickets.spec.ts` | |',
].join('\n');

test('коды берутся только из раздела 7, без повторов', () => {
  expect(frCodes(TZ)).toEqual(['FR-ID-01', 'FR-ID-02', 'FR-TK-01']);
});

test('полный перечень со ссылками на тесты проходит', () => {
  expect(coverageViolations(TZ, LIST, exists)).toEqual([]);
});

test('код из ТЗ без строки перечня: missing', () => {
  const list = LIST.split('\n').filter((line) => !line.startsWith('| FR-TK-01')).join('\n');
  expect(coverageViolations(TZ, list, exists)).toEqual([{ rule: 'missing', code: 'FR-TK-01' }]);
});

test('код, которого нет в разделе 7: unknown', () => {
  const list = `${LIST}\n| FR-UX-01 | сделано | \`tests/e2e/tickets.spec.ts\` | |`;
  expect(coverageViolations(TZ, list, exists)).toEqual([{ rule: 'unknown', code: 'FR-UX-01' }]);
});

test('"сделано" и "сделано на заглушке" без пути к тесту: no_evidence', () => {
  const list = LIST.replace('| FR-ID-02 | сделано | `tests/integration/sso-flow.test.ts` |', '| FR-ID-02 | сделано | `src/modules/hdu/api.ts` |').replace(
    '| FR-ID-01 | сделано на заглушке | `tests/integration/sso-flow.test.ts` |',
    '| FR-ID-01 | сделано на заглушке | нет |',
  );
  expect(coverageViolations(TZ, list, () => true)).toEqual([
    { rule: 'no_evidence', code: 'FR-ID-01' },
    { rule: 'no_evidence', code: 'FR-ID-02' },
  ]);
});

test('"перенесено" без номера решения: no_decision; с решением проходит', () => {
  const without = LIST.replace('| FR-TK-01 | сделано | `tests/e2e/tickets.spec.ts` | |', '| FR-TK-01 | перенесено | | После пилота |');
  expect(coverageViolations(TZ, without, exists)).toEqual([{ rule: 'no_decision', code: 'FR-TK-01' }]);
  const withFile = LIST.replace('| FR-TK-01 | сделано | `tests/e2e/tickets.spec.ts` | |', '| FR-TK-01 | перенесено | `docs/decisions/0043-preset-rules.md` | После пилота |');
  expect(coverageViolations(TZ, withFile, exists)).toEqual([]);
  const withTz = LIST.replace('| FR-TK-01 | сделано | `tests/e2e/tickets.spec.ts` | |', '| FR-TK-01 | перенесено | | Решение ТЗ 83, этап 3 |');
  expect(coverageViolations(TZ, withTz, exists)).toEqual([]);
});

test('ссылка на несуществующий файл: dead_link с путём', () => {
  const list = LIST.replace('`tests/e2e/tickets.spec.ts`', '`tests/e2e/tickets.spec.ts`, `tests/e2e/gone.spec.ts`');
  expect(coverageViolations(TZ, list, exists)).toEqual([{ rule: 'dead_link', code: 'FR-TK-01', path: 'tests/e2e/gone.spec.ts' }]);
});

test('неизвестное состояние: bad_state', () => {
  const list = LIST.replace('| FR-TK-01 | сделано |', '| FR-TK-01 | почти |');
  expect(coverageViolations(TZ, list, exists)).toEqual([{ rule: 'bad_state', code: 'FR-TK-01' }]);
});

test('настоящий перечень docs/plans/M9-requirements.md сходится с ТЗ', () => {
  expect(frCoverageCheck()).toEqual([]);
});
