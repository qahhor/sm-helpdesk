import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { LOCALES } from '@/i18n/locales';
import { enqueue, FRESH_SIGN_IN_SEC, isFresh, readSetting, type StaffContext, writeSettingTx } from '@/modules/hdc/api';
import { normalizeDomain } from '../checks';
import { articleByNumberTx } from '../core/editor';
import { archiveTx, markTextReadTx, publishTx, type PublishOutcome } from '../core/publish';
import { HdkError } from '../error';
import { ALLOWED_DOMAINS_MAX, ALLOWED_DOMAINS_SETTING, ARTICLE_NUMBER_MAX, KB_PUBLISHER_ROLES, KB_WRITER_ROLES, REVISION_MAX } from '../pref';

// Модуль hdk, слой api: публикация, архив, "Текст прочитан" и список разрешённых доменов (план M5, задача 4; FR-SOL-04,
// 05, ТЗ 18.10; решения 10, 11, 15). Публикуют и архивируют только agent_l2, care, admin: проверка здесь и политиками
// базы. Задача kb.index ставится после фиксации транзакции: откат публикации не оставляет задачи.

export type { PublishOutcome } from '../core/publish';
export type { Finding, Readiness } from '../checks';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdkError('invalid_input');
  return parsed.data;
}

const hasRole = (ctx: StaffContext, roles: readonly string[]) => ctx.actor.type === 'staff' && roles.includes(ctx.actor.staffRole);

const number = z.coerce.number().int().positive().max(ARTICLE_NUMBER_MAX);
const versionRef = { number, locale: z.enum(LOCALES), versionId: z.uuid(), revision: z.string().min(1).max(REVISION_MAX) };
const publishInput = z.strictObject({ ...versionRef, confirmFindings: z.boolean(), untrustedConfirmed: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(200).optional() });

/** Разрешённые домены ссылок решения (настройка администратора). Нет настройки: пусто, внешние ссылки не публикуются. */
export async function readAllowedDomains(): Promise<string[]> {
  const value = await readSetting(ALLOWED_DOMAINS_SETTING);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && normalizeDomain(item) === item) : [];
}

/**
 * Публикация версии одной транзакцией (ТЗ 18.10): прежняя версия superseded, копия в hdk_published, переводы оригинала
 * outdated, журнал аудита. Не готово (панель готовности, находки без подтверждения, ссылка вне списка, непроверенный
 * файл): итог not_ready с причинами, ничего не меняется.
 */
export async function publishSolution(ctx: StaffContext, input: unknown): Promise<PublishOutcome> {
  if (!hasRole(ctx, KB_PUBLISHER_ROLES)) throw new HdkError('forbidden');
  const data = parse(publishInput, input);
  const allowedDomains = await readAllowedDomains();
  let result: { outcome: PublishOutcome; articleId: string | null };
  try {
    result = await withActor(ctx.actor, async (tx) => {
      const article = await articleByNumberTx(tx, data.number, { lock: true });
      if (!article) return { outcome: { status: 'not_found' } as const, articleId: null };
      return { outcome: await publishTx(tx, article, { ...data, allowedDomains }), articleId: article.articleId };
    });
  } catch (error) {
    // Второй черновик или вторая опубликованная версия языка (обогнали другой вкладкой): конфликт, а не ошибка (0057).
    if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '23505') return { status: 'conflict' };
    throw error;
  }
  if (result.outcome.status === 'not_found') throw new HdkError('not_found');
  if (result.outcome.status === 'published' && result.articleId) await enqueue('kb.index', { articleId: result.articleId });
  return result.outcome;
}

/** Архив (решение 11): клиент теряет решение сразу, старый адрес открывает "Решение больше не действует". */
export async function archiveSolution(ctx: StaffContext, input: unknown): Promise<void> {
  if (!hasRole(ctx, KB_PUBLISHER_ROLES)) throw new HdkError('forbidden');
  const data = parse(z.strictObject({ number }), input);
  await withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number, { lock: true });
    if (!article) throw new HdkError('not_found');
    if (!(await archiveTx(tx, article))) throw new HdkError('invalid_input');
  });
}

/** "Текст прочитан" для текста модели (решение 15): ставят роли черновиков, запись в журнал. */
export async function markSolutionTextRead(ctx: StaffContext, input: unknown): Promise<{ status: 'read'; revision: string } | { status: 'conflict' }> {
  if (!hasRole(ctx, KB_WRITER_ROLES)) throw new HdkError('forbidden');
  const data = parse(z.strictObject(versionRef), input);
  return withActor(ctx.actor, async (tx) => {
    const article = await articleByNumberTx(tx, data.number);
    if (!article) throw new HdkError('not_found');
    const result = await markTextReadTx(tx, article, data);
    return result === 'conflict' ? ({ status: 'conflict' } as const) : ({ status: 'read', revision: result.revision } as const);
  });
}

// --- Настройка администратора: разрешённые домены ссылок (FR-SOL-04) ---

function requireAdmin(ctx: StaffContext): void {
  if (!hasRole(ctx, ['admin'])) throw new HdkError('forbidden');
}

/** Список для экрана настроек. */
export async function allowedDomainsSetting(ctx: StaffContext): Promise<string[]> {
  requireAdmin(ctx);
  return readAllowedDomains();
}

/**
 * Домены через строку, запятую или пробел; адрес превращается в домен, повторы убираются. Неверная строка
 * называется, ничего не сохраняется. Администратор со входом не старше 15 минут, запись в журнал.
 */
export async function saveAllowedDomains(ctx: StaffContext, input: unknown): Promise<{ ok: true; domains: string[] } | { ok: false; invalid: string }> {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdkError('stale_session');
  const { text } = parse(z.strictObject({ text: z.string().max(10_000) }), input);
  const domains: string[] = [];
  for (const item of text.split(/[\s,;]+/).filter(Boolean)) {
    const domain = normalizeDomain(item);
    if (!domain) return { ok: false, invalid: item.slice(0, 100) };
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length > ALLOWED_DOMAINS_MAX) throw new HdkError('invalid_input');
  await withActor(ctx.actor, (tx) => writeSettingTx(tx, ALLOWED_DOMAINS_SETTING, domains));
  return { ok: true, domains };
}
