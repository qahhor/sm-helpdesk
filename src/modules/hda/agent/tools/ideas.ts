import { and, desc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { moduleCodesTx } from '@/modules/hdr/api';
import { IDEA_STATUSES } from '@/modules/hdi/pref';
import { agentExcerpt } from '../anonymize';
import { defineTool, type Redactor } from '../tool';
import { AGENT_NOTICE, iso, moment, notice, str, UNTRUSTED_HINT } from '../util';
import { agentIdeasView } from '../views';

// Инструмент list_ideas (веха M8b, задачи 4-5; FR-AGT-03; план M8b, решение 17): опубликованные идеи с голосами и
// статусом, без авторов и организаций. Идеи организаций без AI-обработки закрывает представление hda_agent_ideas.
// Текст идеи пишет клиент: он обезличивается и лежит только в untrusted_customer_text.

const LIMIT = 50;
const TITLE_MAX = 300;
const BODY_MAX = 1000;
const PUBLIC_STATUSES = IDEA_STATUSES.filter((status) => status !== 'pending_review' && status !== 'declined');

const input = z.strictObject({
  status: z.enum(PUBLIC_STATUSES as [string, ...string[]]).optional(),
  limit: z.number().int().min(1).max(LIMIT).default(LIMIT),
});

const item = z.strictObject({
  number: z.number().int(),
  status: str(20),
  module: str(80).nullable(),
  votes: z.number().int(),
  org_count: z.number().int(),
  comment_count: z.number().int(),
  published_on: moment.nullable(),
  released_in: str(60).nullable(),
  locale: str(5),
  untrusted_customer_text: z.strictObject({ title: str(TITLE_MAX + 1), body: str(BODY_MAX + 1) }),
});
const output = z.strictObject({ notice, items: z.array(item).max(LIMIT) });

export const listIdeas = defineTool({
  name: 'list_ideas',
  kind: 'read',
  description: `Published product ideas with votes and status, most voted first, without authors or organizations. At most ${LIMIT}. ${UNTRUSTED_HINT}`,
  input,
  output,
  async run(tx, _actor, args) {
    const rows = await tx
      .select()
      .from(agentIdeasView)
      .where(and(args.status ? eq(agentIdeasView.status, args.status) : undefined))
      .orderBy(desc(agentIdeasView.voteCount), desc(agentIdeasView.number))
      .limit(args.limit);
    const modules = await moduleCodesTx(tx, rows.flatMap((row) => (row.moduleId ? [row.moduleId] : [])));
    // Текст обезличивается словами организации автора и сотрудников (находка I2); организация агенту не отдаётся.
    return {
      redact: { orgIds: rows.map((row) => row.orgId) },
      finish: (redact: Redactor) => {
    const clean = (orgId: string, text: string) => redact(orgId, text);
    const items = rows.map((row) => ({
      number: row.number,
      status: row.status,
      module: row.moduleId ? (modules.get(row.moduleId) ?? null) : null,
      votes: row.voteCount,
      org_count: row.orgCount,
      comment_count: row.commentCount,
      published_on: iso(row.publishedOn),
      released_in: row.releasedIn ? row.releasedIn.slice(0, 60) : null,
      locale: row.originalLocale,
      untrusted_customer_text: { title: agentExcerpt(clean(row.orgId, row.title), TITLE_MAX), body: agentExcerpt(clean(row.orgId, row.body), BODY_MAX) },
    }));
    return { result: { notice: AGENT_NOTICE, items }, objectRefs: items.map((idea) => ({ kind: 'idea' as const, ref: idea.number })) };
      },
    };
  },
});

export const ideaTools = [listIdeas];
