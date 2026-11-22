import 'server-only';
import { eq } from 'drizzle-orm';
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
 * Запись настройки в транзакции администратора (политика базы пускает только его) с записью журнала: код и новое
 * значение. Секретов в настройках нет (раздел 11.11): значение в журнале безопасно.
 */
export async function writeSettingTx(tx: Tx, code: string, value: unknown, opts: { audit?: boolean } = {}): Promise<void> {
  const updated = await tx.update(appSettings).set({ value }).where(eq(appSettings.code, code)).returning({ settingId: appSettings.settingId });
  if (updated.length === 0) await tx.insert(appSettings).values({ code, value });
  // Несколько настроек одного экрана вызывающий может записать одной своей записью журнала.
  if (opts.audit !== false) await writeAudit(tx, { action: 'settings.changed', objectType: 'setting', objectId: code, diff: { code, to: value } });
}
