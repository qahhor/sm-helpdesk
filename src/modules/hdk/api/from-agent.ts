import 'server-only';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import type { AgentActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { stripInvisible } from '@/modules/hdc/pref';
import { type Block, safeParseSolutionDoc, type SolutionDoc } from '../doc-schema';
import { HdkError } from '../error';
import { kbArticles, kbArticleSources, kbArticleTranslations, kbArticleVersions } from '../schema';

// Модуль hdk, слой api: черновик решения от AI-сотрудника (веха M8b, задача 6; FR-AGT-04, 05, 07; план M8b, решение
// 21). В транзакции инструмента сервера MCP от актора agent: статья с is_agent_draft и is_untrusted, аудитория
// internal, первая версия-черновик из абзацев текста агента (только текстовые узлы: ни ссылок, ни разметки),
// обращения-источники. Политики базы пускают это только основному токену и только в обращения, видные агенту.
// Публикует сотрудник обычным порядком FR-SOL-04, 05 с отметкой каждой находки недоверенного текста. Правка
// существующего решения агентом идёт новым черновиком со ссылкой revises_article_id: чужую статью агент не меняет.
// Без returning: читать статьи актору agent не дано, идентификаторы и номер берутся заранее.

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const PARAGRAPHS_MAX = 200;

const input = z.strictObject({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(20_000),
  locale: z.enum(LOCALES),
  moduleId: z.uuid().nullable(),
  revisesArticleId: z.uuid().nullable(),
  sources: z.array(z.strictObject({ ticketId: z.uuid(), orgId: z.uuid() })).max(50),
});

const blockId = () => randomUUID().replace(/-/g, '').slice(0, 24);

/** Документ из текста агента: абзац на каждую непустую строку, только текст. */
export function agentTextDoc(text: string): SolutionDoc {
  const parts = stripInvisible(text)
    .replace(CONTROL, '')
    .split(/\n+/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, PARAGRAPHS_MAX);
  const blocks = (parts.length > 0 ? parts : ['']).map((part) => ({ type: 'paragraph', attrs: { id: blockId() }, ...(part ? { content: [{ type: 'text', text: part.slice(0, 10_000) }] } : {}) }) as Block);
  return { version: 1, blocks };
}

export async function createSolutionDraftFromAgentTx(tx: Tx, actor: AgentActor, value: z.input<typeof input>): Promise<{ articleId: string; number: number }> {
  if (actor.type !== 'agent' || actor.ticketId !== null) throw new HdkError('forbidden');
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HdkError('invalid_input');
  const data = parsed.data;
  const doc = safeParseSolutionDoc(agentTextDoc(data.body));
  if (!doc.success) throw new HdkError('invalid_input');
  const articleId = randomUUID();
  const versionId = randomUUID();
  const numbered = await tx.execute<{ number: string }>(sql`select nextval('hdk_articles_number_sq')::text as number`);
  const number = Number(numbered.rows[0]!.number);
  await tx.insert(kbArticles).values({
    articleId,
    number,
    audience: 'internal',
    moduleId: data.moduleId,
    ownerId: null,
    originalLocale: data.locale,
    isUntrusted: true,
    isAgentDraft: true,
    revisesArticleId: data.revisesArticleId,
  });
  await tx.insert(kbArticleVersions).values({ versionId, articleId, locale: data.locale, number: 1, title: data.title, doc: doc.data });
  await tx.insert(kbArticleTranslations).values({ articleId, locale: data.locale, draftVersionId: versionId, status: 'reviewed' });
  if (data.sources.length > 0) await tx.insert(kbArticleSources).values(data.sources.map((s) => ({ ...s, articleId })));
  return { articleId, number };
}
