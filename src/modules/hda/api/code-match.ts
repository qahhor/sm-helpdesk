import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { logEvent } from '@/lib/log';
import { codeErrorEntries } from '../schema';

// Модуль hda, слой api: сигнатура по утверждённым шаблонам знаний из кода (веха M8c, задача 5; ТЗ 7.22 FR-CODE-04,
// 05; план M8c, решение 8). Для модуля знаний hdk: запись сигнатуры обращения, подсказка, баннер, привязка
// сотрудником. Функция базы app.hda_code_signature() с правами владельца отдаёт только сигнатуру утверждённой записи
// (32 знака хеша) или пусто: ни условий, ни "что проверить", ни шаблонов. Поэтому система, помощник и подсказка
// знаний из кода не получают. Шаблоны не хранятся в памяти процесса: сопоставление каждый раз в базе.

const SYSTEM = { type: 'system', job: 'code.match' } as const;
/** Сколько строк сопоставляется: строка ошибки и строки описания (решение 8). */
export const CODE_MATCH_LINES = 31;
const LINE_MAX = 500;
/** Предел запроса сопоставления (решение 0134): функция базы останавливается раньше, через 300 мс. */
const STATEMENT_TIMEOUT_MS = 1000;

/** Проба для тестов: вызывается на каждое сопоставление (независимая проверка M8c, находка C1). */
let probe: (() => void) | null = null;
export function setCodeMatchProbeForTests(fn: (() => void) | null): void {
  probe = fn;
}

/** Строки для сопоставления: без пустых и повторов, до 31 и до 500 знаков. */
export function codeMatchLines(lines: readonly string[]): string[] {
  return [...new Set(lines.map((line) => line.trim().slice(0, LINE_MAX)).filter(Boolean))].slice(0, CODE_MATCH_LINES);
}

/**
 * Сигнатура утверждённой записи, шаблон которой совпал с одной из строк, с учётом кода ошибки; иначе null. Функция
 * базы сама ограничена по времени (решение 0134); предел запроса здесь второй защитой. Сбой сопоставления даёт null:
 * сигнатура тогда определяется по 11.5, обращение и подсказка работают.
 */
export async function codeTemplateSignature(input: { code: string | null; lines: readonly string[] }): Promise<string | null> {
  const lines = codeMatchLines(input.lines);
  if (lines.length === 0) return null;
  probe?.();
  const code = input.code?.trim().toUpperCase() || null;
  try {
    const result = await withActor(SYSTEM, async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${`${STATEMENT_TIMEOUT_MS}ms`}, true)`);
      return tx.execute<{ signature: string | null }>(sql`select app.hda_code_signature(${code}::text, array(select jsonb_array_elements_text(${JSON.stringify(lines)}::jsonb))) as signature`);
    });
    const signature = result.rows[0]?.signature ?? null;
    return typeof signature === 'string' && /^[0-9a-f]{32}$/.test(signature) ? signature : null;
  } catch (error) {
    logEvent('warn', 'code.match_failed', { error });
    return null;
  }
}

export type CodeMatch = { entryId: string; key: string; status: string; lineNo: number };

/**
 * Записи с данными статусами, шаблон которых совпал со строками, в транзакции вызывающего и по его политикам: блок
 * "Что известно по коду" (находка M2). Та же функция базы, что у сигнатуры.
 */
export async function codeTemplateMatchesTx(tx: Tx, input: { code: string | null; lines: readonly string[]; statuses: readonly string[] }): Promise<CodeMatch[]> {
  const lines = codeMatchLines(input.lines);
  if (lines.length === 0) return [];
  const code = input.code?.trim().toUpperCase() || null;
  const result = await tx.execute<{ entry_id: string; key: string; status: string; line_no: number }>(
    sql`select entry_id, key, status, min(line_no)::int as line_no
          from app.hda_code_matches(${code}::text, array(select jsonb_array_elements_text(${JSON.stringify(lines)}::jsonb)), array(select jsonb_array_elements_text(${JSON.stringify(input.statuses)}::jsonb)))
         group by entry_id, key, status`,
  );
  return result.rows.map((row) => ({ entryId: row.entry_id, key: row.key, status: row.status, lineNo: Number(row.line_no) }));
}

/**
 * Внутренние имена записи каталога для проверки перед публикацией решения из записи (веха M8c, FR-CODE-07, FR-SOL-04):
 * ключ, объекты и их части, пути и имена файлов. В транзакции вызывающего: запись видят только читающие знания из
 * кода, остальным список пуст (проверка тогда опирается на общие правила внутренних имён).
 */
export async function codeEntryTermsTx(tx: Tx, entryId: string): Promise<string[]> {
  const [row] = await tx.select({ key: codeErrorEntries.key, raisedIn: codeErrorEntries.raisedIn }).from(codeErrorEntries).where(eq(codeErrorEntries.entryId, entryId)).limit(1);
  if (!row) return [];
  const terms = new Set<string>([row.key]);
  for (const place of row.raisedIn) {
    terms.add(place.object);
    for (const part of place.object.split(/[.:#$]/)) if (part.length >= 4) terms.add(part);
    terms.add(place.path);
    const file = place.path.split('/').pop();
    if (file) terms.add(file);
  }
  return [...terms];
}
