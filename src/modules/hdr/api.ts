import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { type Actor, withActor } from '@/db/with-actor';
import { productModules } from './schema';

// Модуль hdr (справочники), слой api: то, что могут вызывать страницы и другие модули.
// Справочник модулей Smartup читают все акторы (раздел 10.5).

export type ModuleOption = { moduleId: string; code: string; name: string };

/** Действует ли модуль справочника. Отключённый и несуществующий: ложь. */
export async function isActiveModule(actor: Actor, moduleId: string): Promise<boolean> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ moduleId: productModules.moduleId })
      .from(productModules)
      .where(and(eq(productModules.moduleId, moduleId), eq(productModules.state, 'active')))
      .limit(1),
  );
  return rows.length > 0;
}

/** Действующие модули с названием на языке страницы (русское, если перевода нет), по коду. */
export async function listActiveModules(actor: Actor, locale: string): Promise<ModuleOption[]> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select({ moduleId: productModules.moduleId, code: productModules.code, name: productModules.name })
      .from(productModules)
      .where(eq(productModules.state, 'active'))
      .orderBy(asc(productModules.code)),
  );
  return rows.map((row) => ({ moduleId: row.moduleId, code: row.code, name: row.name[locale] ?? row.name.ru }));
}
