import sample from '../fixtures/code/scan-sample.json';

// Отчёт о сканировании кода для тестов (веха M8c, план M8c, решение 30): отчёт-пример 7.22 и его варианты. Сторона
// Hermes Agent и доступ к репозиториям Smartup в тестах заменены этим отчётом.

export type SampleReport = typeof sample;

/** Копия отчёта-примера, которую тест может менять. */
export function sampleReport(): SampleReport {
  return structuredClone(sample);
}

/** Отчёт-пример с уникальными ключами, кодами модулей и идентификатором сканирования. */
export function uniqueReport(tag: string = `${Date.now()}${Math.floor(Math.random() * 1000)}`): SampleReport {
  const report = sampleReport();
  report.scanId = `w-${tag}`;
  report.repository = `smartup-${tag}`.toLowerCase();
  for (const error of report.errors) error.key = `${error.key}_${tag}`;
  for (const item of report.modules) item.code = `${item.code}_${tag}`;
  for (const error of report.errors) error.module = `${error.module}_${tag}`;
  report.changes = { added: report.errors.map((e) => e.key), changed: [], removed: [] };
  return report;
}

/** Строки длиннее предела (FR-CODE-12): count строк кода. */
export function codeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `  v_qty := v_qty + ${i};`).join('\n');
}
