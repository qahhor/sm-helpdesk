import 'server-only';
import { isIP } from 'node:net';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { Tx } from '@/db/client';
import { type Actor, withActor } from '@/db/with-actor';
import { HdcError } from './error';
import { AUDIT_ACTIONS, type AuditAction } from './pref';
import { auditLog } from './schema';

// Журнал аудита (ТЗ 14.3). Запись делается в транзакции самого действия: откатилось действие,
// откатилась и запись. Кто действует, функция не принимает: это заполняет база по актору транзакции.

export type AuditEntry = {
  action: AuditAction;
  /** Вид объекта: staff, server, membership, invitation, user, session. */
  objectType: string;
  objectId?: string;
  /** Организация клиента, которой касается действие. */
  orgId?: string;
  /** Что изменилось. Без секретов и текстов обращений. */
  diff?: Record<string, unknown>;
  ip?: string | null;
};

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);
// Слова, под которыми в журнал мог бы попасть секрет. Имя поля делится на слова (camelCase, snake_case,
// дефисы), поле со словом из списка отклоняется на любой глубине. Отдельные слова, а не подстроки:
// код сервера (code) и состояние passive секретами не являются (проверка main, Q4).
const SECRET_WORDS = new Set(['password', 'passwd', 'pass', 'secret', 'token', 'hash', 'otp', 'totp', 'backup', 'key', 'apikey', 'cookie', 'credential', 'credentials']);
const MAX_DIFF_CHARS = 4000;

const wordsOf = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function hasSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => wordsOf(key).some((word) => SECRET_WORDS.has(word)) || hasSecretKey(nested));
}

/** Добавляет запись в журнал аудита внутри транзакции действия (withActor или withIdentity). */
export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  if (!KNOWN_ACTIONS.has(entry.action)) throw new Error('Журнал аудита: неизвестное действие');
  if (entry.diff !== undefined) {
    if (hasSecretKey(entry.diff)) throw new Error('Журнал аудита: в описании изменения есть поле, похожее на секрет');
    if (JSON.stringify(entry.diff).length > MAX_DIFF_CHARS)
      throw new Error('Журнал аудита: описание изменения слишком большое');
  }
  if (entry.ip != null && isIP(entry.ip) === 0) throw new Error('Журнал аудита: неверный адрес запроса');
  await tx.insert(auditLog).values({
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    orgId: entry.orgId,
    diff: entry.diff,
    ip: entry.ip ?? undefined,
  });
}

// --- Просмотр журнала (FR-ADM-07, решение 0019) ---

export type AuditRow = {
  auditId: string;
  createdOn: Date;
  actorType: string;
  actorId: string | null;
  /** Имя автора из представления hdu_user_profiles. У системы пусто. */
  actorName: string | null;
  action: AuditAction;
  objectType: string;
  objectId: string | null;
  orgId: string | null;
  orgName: string | null;
  diff: Record<string, unknown> | null;
  ip: string | null;
};

/** Строк на странице журнала. */
export const AUDIT_PAGE_SIZE = 50;
/** Период по умолчанию: последние 7 дней. */
const DEFAULT_PERIOD_MS = 7 * 24 * 3600 * 1000;

const auditQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    actorId: z.string().trim().min(1).max(100).optional(),
    objectType: z.string().regex(/^[a-z_]{1,40}$/).optional(),
    objectId: z.string().trim().min(1).max(200).optional(),
    orgId: z.uuid().optional(),
    // Курсор: идентификатор последней строки прошлой страницы.
    cursor: z.uuid().optional(),
  })
  .strict();

/**
 * Страница журнала от новых записей к старым, по 50 строк. Читает только администратор портала:
 * запрос идёт через withActor под ролью hub_app, политика hdc_audit_log_admin_select пропускает только его.
 * Имена автора и организации берутся из общих для показа представления и таблицы (hdu_user_profiles,
 * hdu_organizations) подзапросом: модуль hdc не зависит от кода модуля hdu.
 */
export async function listAudit(ctx: { actor: Actor }, input: unknown): Promise<{ items: AuditRow[]; nextCursor: string | null }> {
  if (ctx.actor.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdcError('forbidden');
  const parsed = auditQuery.safeParse(input ?? {});
  if (!parsed.success) throw new HdcError('invalid_input');
  const q = parsed.data;
  const from = q.from ?? new Date(Date.now() - DEFAULT_PERIOD_MS);
  const where = and(
    gte(auditLog.createdOn, from),
    q.to ? lte(auditLog.createdOn, q.to) : undefined,
    q.action ? eq(auditLog.action, q.action) : undefined,
    q.actorId ? eq(auditLog.actorId, q.actorId) : undefined,
    q.objectType ? eq(auditLog.objectType, q.objectType) : undefined,
    q.objectId ? eq(auditLog.objectId, q.objectId) : undefined,
    q.orgId ? eq(auditLog.orgId, q.orgId) : undefined,
    // Порядок по времени записи, при равном времени по идентификатору: строки одной транзакции имеют одно время.
    q.cursor
      ? sql`(${auditLog.createdOn}, ${auditLog.auditId}) < (select c.created_on, c.audit_id from hdc_audit_log c where c.audit_id = ${q.cursor})`
      : undefined,
  );
  const rows = await withActor(ctx.actor, (tx) =>
    tx
      .select({
        auditId: auditLog.auditId,
        createdOn: auditLog.createdOn,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        // Колонки внешней таблицы названы полностью: без имени таблицы org_id совпал бы с колонкой подзапроса.
        actorName: sql<string | null>`(select p.name from hdu_user_profiles p where p.user_id::text = hdc_audit_log.actor_id)`,
        action: auditLog.action,
        objectType: auditLog.objectType,
        objectId: auditLog.objectId,
        orgId: auditLog.orgId,
        orgName: sql<string | null>`(select o.name from hdu_organizations o where o.org_id = hdc_audit_log.org_id)`,
        diff: auditLog.diff,
        ip: sql<string | null>`host(${auditLog.ip})`,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdOn), desc(auditLog.auditId))
      .limit(AUDIT_PAGE_SIZE + 1),
  );
  const items = rows.slice(0, AUDIT_PAGE_SIZE).map((row) => ({ ...row, action: row.action as AuditAction, diff: row.diff ?? null }));
  return { items, nextCursor: rows.length > AUDIT_PAGE_SIZE ? (items.at(-1)?.auditId ?? null) : null };
}
