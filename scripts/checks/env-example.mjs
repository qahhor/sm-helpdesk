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
