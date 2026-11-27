// Документы безопасности (план M9, задача 6; ASVS V13.1.1, V16.3.3). docs/security/policies.md называет каждый внешний
// узел, к которому обращается портал или его страница (адреса https в исходниках src и переменные адресов
// .env.example), и каждый код события безопасности журналов (журнал аудита src/modules/hdc/pref.ts и журнал процесса
// logEvent): входы, отказы в правах, сессии, сотрудники, токены AI-сотрудников. Лишний пункт перечня тоже ошибка:
// документ не обещает того, чего в коде нет. Узлы примеров (example.com, .example, .invalid, .test, localhost) не
// считаются. src/security/outbound.ts своего списка узлов не держит: адреса серверов Smartup и вебхуков вводит
// администратор, их перечень строкой "адреса из настроек".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
export const POLICIES_FILE = 'docs/security/policies.md';
const HOSTS_SECTION = 'Внешние узлы';
const EVENTS_SECTION = 'События безопасности';
const SECURITY_CODE = /^(auth|authz|session|staff)\.[a-z_]+$|^agent\.(run_)?token[a-z_]*$/;
const EXAMPLE_HOST = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost)$/;

/** @param {string} text @returns {string[]} узлы адресов https:// в тексте, без примеров и шаблонов */
export function hostsInSource(text) {
  const hosts = [...text.matchAll(/https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/g)].map((m) => m[1]);
  return [...new Set(hosts.filter((host) => !EXAMPLE_HOST.test(host)))];
}

/** @param {string} text @returns {string[]} переменные адресов (*_URL, *_HOST, *_HOSTS, *_ENDPOINT) .env.example, и закомментированные */
export function urlVarsInEnvExample(text) {
  return [...new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*_(?:URL|HOST|HOSTS|ENDPOINT))=/gm)].map((m) => m[1]))];
}

/** @param {string} text @returns {string[]} коды событий в вызовах logEvent (строки вида area.name) */
export function logCodesInSource(text) {
  /** @type {string[]} */
  const codes = [];
  for (const line of text.split('\n')) {
    if (!line.includes('logEvent(')) continue;
    for (const m of line.matchAll(/'([a-z]+\.[a-z_]+)'/g)) codes.push(m[1]);
  }
  return [...new Set(codes)];
}

/** @param {string} text @returns {string[]} коды перечня AUDIT_ACTIONS */
function auditCodes(text) {
  const start = text.indexOf('export const AUDIT_ACTIONS = [');
  const end = text.indexOf('] as const;', start);
  if (start < 0 || end < 0) return [];
  return [...text.slice(start, end).matchAll(/^\s*'([a-z]+\.[a-z_]+)',/gm)].map((m) => m[1]);
}

/** @param {string} text @param {string} title @returns {string | null} текст раздела "## title" или "## N. title ..." до следующего "## " */
function section(text, title) {
  const start = text.search(new RegExp(`^## (?:\\d+\\. )?${title}(?=[\\s(]|$)`, 'm'));
  if (start < 0) return null;
  const rest = text.slice(start + 3);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** @param {string} text @returns {string[]} значения в `...` в первой ячейке строк таблиц раздела */
function firstCells(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]));
}

/**
 * @param {string} policies текст policies.md
 * @param {{ hosts: string[]; urlVars: string[]; codes: string[] }} sources
 * @returns {string[]}
 */
export function securityDocsProblems(policies, sources) {
  /** @type {string[]} */
  const problems = [];
  const hostsText = section(policies, HOSTS_SECTION);
  const eventsText = section(policies, EVENTS_SECTION);
  if (hostsText === null) problems.push(`нет раздела "${HOSTS_SECTION}"`);
  if (eventsText === null) problems.push(`нет раздела "${EVENTS_SECTION}"`);
  if (hostsText === null || eventsText === null) return problems;

  const listedHosts = new Set(firstCells(hostsText));
  for (const host of sources.hosts) if (!listedHosts.has(host)) problems.push(`внешний узел ${host} не назван в разделе "${HOSTS_SECTION}"`);
  for (const name of sources.urlVars) if (!listedHosts.has(name)) problems.push(`переменная адреса ${name} не названа в разделе "${HOSTS_SECTION}"`);
  const known = new Set([...sources.hosts, ...sources.urlVars]);
  for (const item of listedHosts)
    if (!known.has(item) && (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(item) || /^[A-Z][A-Z0-9_]*$/.test(item)))
      problems.push(`в разделе "${HOSTS_SECTION}" узел ${item}, которого нет в исходниках и .env.example`);

  const listedCodes = new Set(firstCells(eventsText));
  const codes = new Set(sources.codes);
  for (const code of sources.codes) if (SECURITY_CODE.test(code) && !listedCodes.has(code)) problems.push(`код ${code} не назван в разделе "${EVENTS_SECTION}"`);
  for (const code of listedCodes) if (!codes.has(code)) problems.push(`в разделе "${EVENTS_SECTION}" код ${code}, которого нет в исходниках`);
  return problems;
}

/** @param {string} dir @param {string[]} out @returns {string[]} */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

/** @returns {{ hosts: string[]; urlVars: string[]; codes: string[] }} перечни из исходников репозитория */
export function collectSources() {
  const files = walk(resolve(root, 'src')).map((path) => readFileSync(path, 'utf8'));
  return {
    hosts: [...new Set(files.flatMap(hostsInSource))].sort(),
    urlVars: urlVarsInEnvExample(readFileSync(resolve(root, '.env.example'), 'utf8')),
    codes: [...new Set([...auditCodes(readFileSync(resolve(root, 'src/modules/hdc/pref.ts'), 'utf8')), ...files.flatMap(logCodesInSource)])],
  };
}

/** @returns {string[]} нарушения настоящего policies.md */
export function securityDocsCheck() {
  let policies;
  try {
    policies = readFileSync(resolve(root, POLICIES_FILE), 'utf8');
  } catch {
    return [`${POLICIES_FILE}: файла нет`];
  }
  return securityDocsProblems(policies, collectSources()).map((problem) => `${POLICIES_FILE}: ${problem}`);
}
