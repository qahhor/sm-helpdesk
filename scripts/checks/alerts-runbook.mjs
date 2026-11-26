// Памятка дежурного описывает каждый сигнал портала (план подготовки M9, задача 3). Коды сигналов задачи ops.watch
// перечислены в OPS_ALERT_CODES (src/modules/hdn/api/ops.ts); в разделе 6 docs/runbooks/incident.md у каждого строка
// с кодом в обратных кавычках: что случилось и что делать.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const RUNBOOK = 'docs/runbooks/incident.md';

/**
 * @param {string} source текст src/modules/hdn/api/ops.ts
 * @returns {string[]} коды сигналов
 */
export function alertCodesOf(source) {
  const list = /OPS_ALERT_CODES = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/**
 * @param {string} runbook текст памятки
 * @returns {string[]} коды в обратных кавычках из раздела 6 (до следующего заголовка второго уровня)
 */
export function runbookAlertCodesOf(runbook) {
  const start = runbook.search(/^## 6\./m);
  if (start < 0) return [];
  const rest = runbook.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/\(`([a-z]+(?:_[a-z]+)+)`\)/g)].map((m) => m[1]);
}

/**
 * @param {string} source
 * @param {string} runbook
 * @returns {string[]} расхождения
 */
export function alertsRunbookGaps(source, runbook) {
  const codes = alertCodesOf(source);
  const described = runbookAlertCodesOf(runbook);
  return [
    ...codes.filter((code) => !described.includes(code)).map((code) => `сигнал ${code} не описан в разделе 6 ${RUNBOOK}`),
    ...described.filter((code) => !codes.includes(code)).map((code) => `в разделе 6 ${RUNBOOK} описан сигнал ${code}, которого портал не шлёт`),
  ];
}

/** @returns {string[]} расхождения настоящей памятки с сигналами портала */
export function alertsRunbookCheck() {
  return alertsRunbookGaps(readFileSync(resolve(root, 'src/modules/hdn/api/ops.ts'), 'utf8'), readFileSync(resolve(root, RUNBOOK), 'utf8'));
}
