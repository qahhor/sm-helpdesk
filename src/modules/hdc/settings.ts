import 'server-only';
import { eq } from 'drizzle-orm';
import { withActor } from '@/db/with-actor';
import { appSettings } from './schema';

// Модуль hdc: настройки портала, которые администратор меняет без выкладки (hdc_settings, раздел 10.5).
// Читает система: клиенту таблица не видна, а значения нужны и его страницам (например, срок повторного открытия).

const SYSTEM = { type: 'system', job: 'settings.read' } as const;

/** Значение настройки по коду. Нет строки: пусто. */
export async function readSetting(code: string): Promise<unknown> {
  const rows = await withActor(SYSTEM, (tx) => tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.code, code)).limit(1));
  return rows[0]?.value;
}
