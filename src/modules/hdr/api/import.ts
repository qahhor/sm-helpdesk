import 'server-only';
import type { StaffActor } from '@/db/with-actor';
import { type ImportCounts, type ImportSource, importModulesTx } from '../core/import';
import { type ModuleRecord, modulesFile } from '../input';

// Загрузка справочника модулей из выгрузки Smartup (команда hub modules:import, план M2, задача 10).
// Справочник меняет только администратор портала (политики RLS): команда консоли действует от его имени.
// Ошибки файла называют номер записи и строку, справочник при ошибке не меняется.

export type ImportResult = ({ ok: true } & ImportCounts) | { ok: false; problems: string[] };

/** Номер строки (с 1) каждого элемента верхнего массива JSON: для сообщений об ошибках. */
export function elementLines(text: string): number[] {
  const lines: number[] = [];
  let line = 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectValue = false;
  for (const char of text) {
    if (char === '\n') line += 1;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (depth === 1 && expectValue && !/\s|,|\]/.test(char)) {
      lines.push(line);
      expectValue = false;
    }
    if (char === '"') inString = true;
    else if (char === '[' || char === '{') {
      depth += 1;
      if (depth === 1) expectValue = true;
    } else if (char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 1) expectValue = true;
  }
  return lines;
}

/** Строка ошибки разбора JSON: Node пишет "(line N column M)", иначе считается по позиции. */
function syntaxLine(text: string, message: string): number | null {
  const line = /line (\d+)/.exec(message)?.[1];
  if (line) return Number(line);
  const position = /position (\d+)/.exec(message)?.[1];
  return position ? text.slice(0, Number(position)).split('\n').length : null;
}

/** Повторы кодов, родитель вне файла и циклы родителей. */
function structureProblems(records: readonly ModuleRecord[], where: (index: number) => string): string[] {
  const problems: string[] = [];
  const index = new Map<string, number>();
  records.forEach((record, i) => {
    if (index.has(record.code)) problems.push(`${where(i)}: код ${record.code} уже был в записи ${(index.get(record.code) ?? 0) + 1}`);
    else index.set(record.code, i);
  });
  records.forEach((record, i) => {
    if (record.parentCode && !index.has(record.parentCode)) problems.push(`${where(i)}: родитель ${record.parentCode} не найден в файле`);
  });
  const parent = new Map(records.map((r) => [r.code, r.parentCode ?? null]));
  records.forEach((record, i) => {
    const seen = new Set<string>([record.code]);
    for (let next = parent.get(record.code); next; next = parent.get(next) ?? null) {
      if (seen.has(next)) {
        problems.push(`${where(i)}: родители модуля ${record.code} замыкаются в круг`);
        break;
      }
      seen.add(next);
    }
  });
  return problems;
}

export async function importModules(actor: StaffActor, text: string, source: ImportSource): Promise<ImportResult> {
  if (actor.type !== 'staff' || actor.staffRole !== 'admin') throw new Error('Справочник загружает только администратор');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const line = syntaxLine(text, error instanceof Error ? error.message : '');
    return { ok: false, problems: [`Файл не JSON${line ? `: строка ${line}` : ''}`] };
  }
  const lines = elementLines(text);
  const where = (i: number) => `запись ${i + 1}${lines[i] ? `, строка ${lines[i]}` : ''}`;
  const parsed = modulesFile.safeParse(data);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 20).map((issue) => {
        const [first, ...rest] = issue.path;
        const field = rest.join('.') || 'запись';
        return typeof first === 'number' ? `${where(first)}: ${field}: ${issue.message}` : issue.message;
      }),
    };
  const problems = structureProblems(parsed.data, where);
  if (problems.length > 0) return { ok: false, problems: problems.slice(0, 20) };
  return { ok: true, ...(await importModulesTx(actor, parsed.data, source)) };
}
