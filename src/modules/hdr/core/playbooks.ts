import 'server-only';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { type Actor, type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { HdrError } from '../error';
import { type PlaybookTicketType, playbooks } from '../schema';
import { playbookItems } from '../util';

// Модуль hdr, слой core: памятки первой линии (FR-LINE-10, 10.5; план M3, задача 9). Читают сотрудники,
// ведут вторая линия, care и admin: права держит политика RLS, код проверяет роль раньше, чтобы ответить кодом.

export type Playbook = { playbookId: string; moduleId: string | null; type: PlaybookTicketType; body: string; items: string[]; ownerId: string; updatedOn: Date };

export const PLAYBOOK_KEEPERS = ['agent_l2', 'care', 'admin'] as const;

const view = (row: typeof playbooks.$inferSelect): Playbook => ({
  playbookId: row.playbookId,
  moduleId: row.moduleId,
  type: row.ticketType,
  body: row.body,
  items: playbookItems(row.body),
  ownerId: row.ownerId,
  updatedOn: row.modifiedOn,
});

/** Памятка для модуля и типа, иначе общая памятка типа. Клиенту политика ничего не отдаёт. */
export async function findPlaybookTx(actor: Actor, moduleId: string | null, type: PlaybookTicketType): Promise<Playbook | null> {
  const rows = await withActor(actor, (tx) =>
    tx
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.ticketType, type), moduleId ? or(eq(playbooks.moduleId, moduleId), isNull(playbooks.moduleId)) : isNull(playbooks.moduleId)))
      // Своя памятка модуля важнее общей.
      .orderBy(sql`${playbooks.moduleId} is null`),
  );
  return rows[0] ? view(rows[0]) : null;
}

export async function listPlaybooksTx(actor: StaffActor): Promise<Playbook[]> {
  const rows = await withActor(actor, (tx) => tx.select().from(playbooks).orderBy(asc(playbooks.ticketType), asc(playbooks.moduleId)));
  return rows.map(view);
}

/** Сохранить памятку модуля и типа: та же пара меняет существующую, ответственным становится сохранивший. */
export async function savePlaybookTx(actor: StaffActor, moduleId: string | null, type: PlaybookTicketType, body: string): Promise<void> {
  if (!(PLAYBOOK_KEEPERS as readonly string[]).includes(actor.staffRole)) throw new HdrError('forbidden');
  await withActor(actor, async (tx) => {
    const [saved] = await tx
      .insert(playbooks)
      .values({ moduleId, ticketType: type, body, ownerId: actor.userId })
      .onConflictDoUpdate({ target: [playbooks.moduleId, playbooks.ticketType], set: { body, ownerId: actor.userId } })
      .returning({ playbookId: playbooks.playbookId });
    if (!saved) throw new Error('hdr: памятка не сохранена');
    await writeAudit(tx, { action: 'playbook.saved', objectType: 'playbook', objectId: saved.playbookId, diff: { moduleId, type } });
  });
}
