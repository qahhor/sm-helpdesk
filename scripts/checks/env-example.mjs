// Каждая переменная из схемы src/env.ts описана в .env.example.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

/** @returns {Promise<string[]>} имена переменных схемы */
export async function envSchemaNames() {
  const source = await readFile(resolve(root, 'src/env.ts'), 'utf8');
  // Ключи объекта схемы: имя заглавными буквами в начале строки с отступом.
  return [...new Set([...source.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]))];
}

/** @returns {Promise<string[]>} имена из схемы, которых нет в .env.example */
export async function missingInEnvExample() {
  const example = await readFile(resolve(root, '.env.example'), 'utf8');
  const described = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  return (await envSchemaNames()).filter((name) => !described.has(name));
}

const LAUNCH = 'docs/runbooks/launch.md';

/**
 * @param {string[]} names
 * @param {string} launch текст памятки
 * @param {Set<string>} devOnly переменные, отмеченные в .env.example "только разработка"
 * @returns {string[]} имена, которых нет в памятке целым словом
 */
export function launchGaps(names, launch, devOnly) {
  return names.filter((name) => !devOnly.has(name) && !new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(launch));
}

/** Переменные .env.example со строкой "# только разработка" прямо над ними (через другие комментарии). */
function devOnlyNames(example) {
  /** @type {Set<string>} */
  const names = new Set();
  let marked = false;
  for (const line of example.split('\n')) {
    if (/^#\s*только разработка/i.test(line)) marked = true;
    const name = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line)?.[1];
    if (name) {
      if (marked) names.add(name);
    } else if (!line.startsWith('#')) marked = false;
  }
  return names;
}

/** @returns {Promise<string[]>} переменные схемы и .env.example, которых нет в docs/runbooks/launch.md */
export async function envVarsMissingInLaunch() {
  const example = await readFile(resolve(root, '.env.example'), 'utf8');
  const launch = await readFile(resolve(root, LAUNCH), 'utf8');
  const fromExample = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  const names = [...new Set([...(await envSchemaNames()), ...fromExample])];
  return launchGaps(names, launch, devOnlyNames(example));
}
