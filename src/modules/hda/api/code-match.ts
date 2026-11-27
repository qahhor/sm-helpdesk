import 'server-only';
import { sql } from 'drizzle-orm';
import { withActor } from '@/db/with-actor';

// Модуль hda, слой api: сигнатура по утверждённым шаблонам знаний из кода (веха M8c, задача 5; ТЗ 7.22 FR-CODE-04,
// 05; план M8c, решение 8). Для модуля знаний hdk: запись сигнатуры обращения, подсказка, баннер, привязка
// сотрудником. Функция базы app.hda_code_signature() с правами владельца отдаёт только сигнатуру утверждённой записи
// (32 знака хеша) или пусто: ни условий, ни "что проверить", ни шаблонов. Поэтому система, помощник и подсказка
// знаний из кода не получают. Шаблоны не хранятся в памяти процесса: сопоставление каждый раз в базе.

const SYSTEM = { type: 'system', job: 'code.match' } as const;
/** Сколько строк сопоставляется: строка ошибки и строки описания (решение 8). */
export const CODE_MATCH_LINES = 31;
const LINE_MAX = 500;

/** Сигнатура утверждённой записи, шаблон которой совпал с одной из строк, с учётом кода ошибки; иначе null. */
export async function codeTemplateSignature(input: { code: string | null; lines: readonly string[] }): Promise<string | null> {
  const lines = [...new Set(input.lines.map((line) => line.trim().slice(0, LINE_MAX)).filter(Boolean))].slice(0, CODE_MATCH_LINES);
  if (lines.length === 0) return null;
  const code = input.code?.trim().toUpperCase() || null;
  const result = await withActor(SYSTEM, (tx) => tx.execute<{ signature: string | null }>(sql`select app.hda_code_signature(${code}::text, array(select jsonb_array_elements_text(${JSON.stringify(lines)}::jsonb))) as signature`));
  const signature = result.rows[0]?.signature ?? null;
  return typeof signature === 'string' && /^[0-9a-f]{32}$/.test(signature) ? signature : null;
}
