import { expect, test } from 'vitest';
import { alertCodesOf, alertsRunbookGaps, runbookAlertCodesOf } from '../../../scripts/checks/alerts-runbook.mjs';

// Памятка дежурного (план подготовки M9, задача 3): каждый вид сигнала ops.watch описан в разделе 6
// docs/runbooks/incident.md строкой с кодом сигнала, и в памятке нет кода, которого портал не шлёт.

const SOURCE = `export const OPS_ALERT_CODES = ['jobs_failed', 'outbox_lag', 'backup_stale'] as const;`;
const RUNBOOK = `## 5. После\n\n\`outbox_lag\` здесь не считается\n\n## 6. Сигналы дежурным\n\n| Сигнал | Что |\n|---|---|\n| Упали задачи (\`jobs_failed\`) | x |\n| Копии (\`backup_stale\`) | y |\n| Старое (\`gone_alert\`) | z |\n\n## 7. Дальше\n\n(\`outbox_lag\`)\n`;

test('коды сигналов читаются из списка OPS_ALERT_CODES', () => {
  expect(alertCodesOf(SOURCE)).toEqual(['jobs_failed', 'outbox_lag', 'backup_stale']);
});

test('коды памятки читаются только из раздела 6', () => {
  expect(runbookAlertCodesOf(RUNBOOK)).toEqual(['jobs_failed', 'backup_stale', 'gone_alert']);
});

test('сигнал без строки памятки и строка без сигнала называются', () => {
  expect(alertsRunbookGaps(SOURCE, RUNBOOK)).toEqual([
    'сигнал outbox_lag не описан в разделе 6 docs/runbooks/incident.md',
    'в разделе 6 docs/runbooks/incident.md описан сигнал gone_alert, которого портал не шлёт',
  ]);
});

test('настоящая памятка описывает каждый сигнал портала', async () => {
  const { readFileSync } = await import('node:fs');
  expect(alertsRunbookGaps(readFileSync('src/modules/hdn/api/ops.ts', 'utf8'), readFileSync('docs/runbooks/incident.md', 'utf8'))).toEqual([]);
});
