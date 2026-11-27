// Перечень требований раздела 7 ТЗ (план M9, задача 1, решение 21): docs/plans/M9-requirements.md называет каждый
// код FR разделов 7.1-7.22 с состоянием "сделано", "сделано на заглушке" или "перенесено". "Сделано" ссылается на
// тест (путь в tests/), "перенесено" на решение (файл docs/decisions/ или "решение ТЗ N"), каждая ссылка в `...`
// ведёт на существующий файл. Длинное и среднее тире ловит общая проверка dashes.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export const LIST_FILE = 'docs/plans/M9-requirements.md';
const CODE = /\bFR-[A-Z]+-\d+[a-z]?\b/g;
const STATES = new Set(['сделано', 'сделано на заглушке', 'перенесено']);
const DECISION = /docs\/decisions\/\d{4}-|решени[еяю]\s+(?:ТЗ\s+)?\d+/iu;

/**
 * @param {string} tzText текст docs/TZ.md
 * @returns {string[]} коды FR раздела 7 (от "## 7." до "## 8.") в порядке первого упоминания
 */
export function frCodes(tzText) {
  const start = tzText.search(/^## 7\. /m);
  if (start < 0) return [];
  const rest = tzText.slice(start);
  const end = rest.slice(1).search(/^## 8\. /m);
  const section = end < 0 ? rest : rest.slice(0, end + 1);
  return [...new Set(section.match(CODE) ?? [])];
}

/**
 * @typedef {{ rule: 'missing' | 'unknown' | 'no_evidence' | 'no_decision' | 'dead_link' | 'bad_state'; code: string; path?: string }} Violation
 * @param {string} tzText
 * @param {string} listText текст перечня
 * @param {(path: string) => boolean} exists есть ли файл по пути от корня репозитория
 * @returns {Violation[]}
 */
export function coverageViolations(tzText, listText, exists) {
  const known = new Set(frCodes(tzText));
  /** @type {Violation[]} */
  const violations = [];
  /** @type {Set<string>} */
  const listed = new Set();
  for (const line of listText.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 5 || !/^FR-[A-Z]+-\d+[a-z]?$/.test(cells[1])) continue;
    const [, code, state, evidence, note] = cells;
    listed.add(code);
    if (!known.has(code)) {
      violations.push({ rule: 'unknown', code });
      continue;
    }
    if (!STATES.has(state)) {
      violations.push({ rule: 'bad_state', code });
      continue;
    }
    const paths = [...`${evidence} ${note}`.matchAll(/`([^`\s]+\/[^`\s]+\.[a-z]+)`/g)].map((m) => m[1]);
    if (state !== 'перенесено' && !paths.some((path) => path.startsWith('tests/'))) violations.push({ rule: 'no_evidence', code });
    if (state === 'перенесено' && !DECISION.test(`${evidence} ${note}`)) violations.push({ rule: 'no_decision', code });
    for (const path of paths) if (!exists(path)) violations.push({ rule: 'dead_link', code, path });
  }
  for (const code of known) if (!listed.has(code)) violations.push({ rule: 'missing', code });
  return violations;
}

const MESSAGES = {
  missing: 'нет в перечне',
  unknown: 'нет в разделе 7 ТЗ',
  no_evidence: '"сделано" без пути к тесту',
  no_decision: '"перенесено" без решения',
  dead_link: 'ссылка на несуществующий файл',
  bad_state: 'состояние не из перечня: сделано, сделано на заглушке, перенесено',
};

/** @returns {string[]} нарушения настоящего перечня */
export function frCoverageCheck() {
  let list;
  try {
    list = readFileSync(resolve(root, LIST_FILE), 'utf8');
  } catch {
    return [`${LIST_FILE}: файла нет`];
  }
  const tz = readFileSync(resolve(root, 'docs/TZ.md'), 'utf8');
  return coverageViolations(tz, list, (path) => existsSync(resolve(root, path))).map(
    (v) => `${LIST_FILE} ${v.code}: ${MESSAGES[v.rule]}${v.path ? ` ${v.path}` : ''}`,
  );
}
