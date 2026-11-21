import 'server-only';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import type { ModuleRecord } from '../input';
import { productModules } from '../schema';

// Модуль hdr, слой core: загрузка справочника модулей одной транзакцией. Модули добавляются и обновляются
// по коду, отсутствующие в файле скрываются (passive), родитель ставится вторым проходом.

export type ImportCounts = { added: number; updated: number; passive: number };
export type ImportSource = 'cli';

/** source: откуда пришла загрузка; журнал аудита называет и администратора, и путь (консоль или экран). */
export async function importModulesTx(actor: StaffActor, records: readonly ModuleRecord[], source: ImportSource): Promise<ImportCounts> {
  return withActor(actor, async (tx) => {
    const codes = records.map((r) => r.code);
    const existing = new Map(
      (await tx.select({ code: productModules.code, moduleId: productModules.moduleId }).from(productModules)).map((r) => [r.code, r.moduleId]),
    );
    let added = 0;
    let updated = 0;
    const ids = new Map<string, string>();
    for (const record of records) {
      const values = { name: record.name, screens: record.screens, state: 'active' as const };
      const id = existing.get(record.code);
      if (id) {
        await tx.update(productModules).set(values).where(eq(productModules.moduleId, id));
        ids.set(record.code, id);
        updated += 1;
      } else {
        const [row] = await tx.insert(productModules).values({ ...values, code: record.code }).returning({ moduleId: productModules.moduleId });
        if (!row) throw new Error('hdr: модуль не добавлен');
        ids.set(record.code, row.moduleId);
        added += 1;
      }
    }
    for (const record of records)
      await tx
        .update(productModules)
        .set({ parentId: record.parentCode ? (ids.get(record.parentCode) ?? null) : null })
        .where(eq(productModules.code, record.code));
    const hidden = await tx
      .update(productModules)
      .set({ state: 'passive' })
      .where(and(eq(productModules.state, 'active'), codes.length > 0 ? notInArray(productModules.code, codes) : sql`true`))
      .returning({ moduleId: productModules.moduleId });
    const counts = { added, updated, passive: hidden.length };
    await writeAudit(tx, { action: 'modules.imported', objectType: 'module', objectId: 'catalog', diff: { ...counts, source } });
    return counts;
  });
}
