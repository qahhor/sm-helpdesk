import { sql } from 'drizzle-orm';
import { customType, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { stampColumns } from '@/db/columns';
import type { AiOutcome, AiPurpose } from './pref';

// Модуль hda: AI. Таблицу, ограничения и политики создаёт миграция drizzle/0072_hda_runs.sql. Журнал вызовов не
// хранит текста запроса и ответа (поправка 101).

/** Деньги с шестью знаками после запятой; драйвер отдаёт numeric строкой. */
const usd = customType<{ data: string }>({ dataType: () => 'numeric(12,6)' });

/** Вызовы модели (логическое имя ai_runs): цель, модель, токены, стоимость, время, итог. */
export const aiRuns = pgTable('hda_runs', {
  orgId: uuid('org_id'),
  runId: uuid('run_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  refId: uuid('ref_id'),
  purpose: text('purpose').$type<AiPurpose>().notNull(),
  model: text('model'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: usd('cost_usd').notNull().default('0'),
  latencyMs: integer('latency_ms').notNull().default(0),
  outcome: text('outcome').$type<AiOutcome>().notNull(),
  errorCode: text('error_code'),
  ...stampColumns,
});
