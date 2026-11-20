import 'server-only';
import { isIP } from 'node:net';
import type { Tx } from '@/db/client';
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
// Имена, под которыми в журнал мог бы попасть секрет. Проверяются на любой глубине.
const SECRET_KEY = /pass|secret|token|hash|code/i;
const MAX_DIFF_CHARS = 4000;

function hasSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => SECRET_KEY.test(key) || hasSecretKey(nested));
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
