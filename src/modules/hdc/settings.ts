import 'server-only';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { withActor } from '@/db/with-actor';
import { writeAudit } from './audit';
import { appSettings } from './schema';

// Модуль hdc: настройки портала, которые администратор меняет без выкладки (hdc_settings, раздел 10.5).
// Читает система: клиенту таблица не видна, а значения нужны и его страницам (например, срок повторного открытия).

const SYSTEM = { type: 'system', job: 'settings.read' } as const;

/** Значение настройки по коду. Нет строки: пусто. */
export async function readSetting(code: string): Promise<unknown> {
  const rows = await withActor(SYSTEM, (tx) => tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.code, code)).limit(1));
  return rows[0]?.value;
}

/**
 * Значения нескольких настроек одной выборкой (проверка качества, Q3): экран или задача, которым нужно несколько
 * настроек, не открывают по транзакции на каждую. Кода без строки в ответе нет.
 */
export async function readSettings(codes: readonly string[]): Promise<Map<string, unknown>> {
  if (codes.length === 0) return new Map();
  const rows = await withActor(SYSTEM, (tx) => tx.select({ code: appSettings.code, value: appSettings.value }).from(appSettings).where(inArray(appSettings.code, [...new Set(codes)])));
  return new Map(rows.map((row) => [row.code, row.value]));
}

/**
 * Значение настройки с блокировкой до конца транзакции администратора: чтение и запись списка одной транзакцией без
 * потерянных правок (независимая проверка M9, M4). Строка есть: SELECT ... FOR UPDATE. Строки ещё нет: блокировка
 * транзакции по коду настройки, затем чтение заново: вторая такая же транзакция ждёт и видит строку первой.
 */
export async function lockSettingTx(tx: Tx, code: string): Promise<unknown> {
  const read = async () => (await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.code, code)).limit(1).for('update'))[0];
  const row = await read();
  if (row) return row.value;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`hdc_settings:${code}`}, 0))`);
  return (await read())?.value;
}

/**
 * Запись настройки в транзакции администратора (политика базы пускает только его) с записью журнала: код и новое
 * значение. Секретов в настройках нет (раздел 11.11): значение в журнале безопасно.
 */
export async function writeSettingTx(tx: Tx, code: string, value: unknown, opts: { audit?: boolean } = {}): Promise<void> {
  // Пустое значение хранится как JSON null: колонка обязательная, а null без приведения стал бы пустой ячейкой и
  // ошибкой базы (дежурные без чата Telegram, проверка волны 0).
  const stored = value === null ? sql`'null'::jsonb` : value;
  const updated = await tx.update(appSettings).set({ value: stored }).where(eq(appSettings.code, code)).returning({ settingId: appSettings.settingId });
  if (updated.length === 0) await tx.insert(appSettings).values({ code, value: stored });
  // Несколько настроек одного экрана вызывающий может записать одной своей записью журнала.
  if (opts.audit !== false) await writeAudit(tx, { action: 'settings.changed', objectType: 'setting', objectId: code, diff: { code, to: value } });
}
