import 'server-only';
import { and, asc, eq, ilike, isNull, or } from 'drizzle-orm';
import { type StaffActor, withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { HdrError } from '../error';
import { type LocalizedText, replyTemplates } from '../schema';

// Модуль hdr, слой core: шаблоны ответов (FR-AG-06, 10.5; план M3, задача 10). Читают сотрудники, ведёт
// администратор: права держит политика RLS, код проверяет роль раньше, чтобы ответить кодом.

export type ReplyTemplate = {
  templateId: string;
  shortcut: string;
  title: string;
  body: LocalizedText;
  moduleId: string | null;
  isEnabled: boolean;
};

const columns = {
  templateId: replyTemplates.templateId,
  shortcut: replyTemplates.shortcut,
  title: replyTemplates.title,
  body: replyTemplates.body,
  moduleId: replyTemplates.moduleId,
  isEnabled: replyTemplates.isEnabled,
};

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Включённые шаблоны для поля ответа: общие и шаблоны модуля обращения, с поиском по коду и названию. */
export async function listTemplatesTx(actor: StaffActor, opts: { q?: string; moduleId?: string | null }): Promise<ReplyTemplate[]> {
  const pattern = opts.q ? `%${likeEscape(opts.q)}%` : null;
  return withActor(actor, (tx) =>
    tx
      .select(columns)
      .from(replyTemplates)
      .where(
        and(
          eq(replyTemplates.isEnabled, true),
          opts.moduleId ? or(isNull(replyTemplates.moduleId), eq(replyTemplates.moduleId, opts.moduleId)) : isNull(replyTemplates.moduleId),
          pattern ? or(ilike(replyTemplates.shortcut, pattern), ilike(replyTemplates.title, pattern)) : undefined,
        ),
      )
      .orderBy(asc(replyTemplates.shortcut)),
  );
}

/** Все шаблоны для экрана настроек, включая выключенные. */
export async function listAllTemplatesTx(actor: StaffActor): Promise<ReplyTemplate[]> {
  return withActor(actor, (tx) => tx.select(columns).from(replyTemplates).orderBy(asc(replyTemplates.shortcut)));
}

/** Новый шаблон или правка существующего. Код занят другим шаблоном: shortcut_taken. */
export async function saveTemplateTx(actor: StaffActor, template: Omit<ReplyTemplate, 'templateId'> & { templateId?: string }): Promise<void> {
  if (actor.staffRole !== 'admin') throw new HdrError('forbidden');
  await withActor(actor, async (tx) => {
    const [taken] = await tx.select({ templateId: replyTemplates.templateId }).from(replyTemplates).where(eq(replyTemplates.shortcut, template.shortcut));
    if (taken && taken.templateId !== template.templateId) throw new HdrError('shortcut_taken');
    const values = { shortcut: template.shortcut, title: template.title, body: template.body, moduleId: template.moduleId, isEnabled: template.isEnabled };
    const [saved] = template.templateId
      ? await tx.update(replyTemplates).set(values).where(eq(replyTemplates.templateId, template.templateId)).returning({ templateId: replyTemplates.templateId })
      : await tx.insert(replyTemplates).values(values).returning({ templateId: replyTemplates.templateId });
    if (!saved) throw new HdrError('invalid_input');
    await writeAudit(tx, {
      action: 'template.saved',
      objectType: 'reply_template',
      objectId: saved.templateId,
      diff: { shortcut: template.shortcut, moduleId: template.moduleId, isEnabled: template.isEnabled },
    });
  });
}
