import 'server-only';
import { inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffMember, staffDirectoryTx } from '../core/staff-lookup';
import { SERVICE_ORG_ID } from '../pref';
import { organizations } from '../schema';

// Модуль hdu, слой api: то, что берёт у идентичности модуль правил автоматизации (hdw; план M8, задача 3).
// Узкий файл: его тянет фоновый процесс. Сотрудников читает система под ролью hub_auth (таблица сотрудников
// закрыта для hub_app), организации читаются в транзакции вызывающего под политикой для сотрудников и системы.

export type { StaffMember } from '../core/staff-lookup';

/** Действующие сотрудники-люди с именами и ролями: исполнители, получатели уведомлений, распределение по кругу. */
export function staffRoster(): Promise<StaffMember[]> {
  return staffDirectoryTx({ writersOnly: false });
}

export type OrgFacts = { name: string; category: 'A' | 'B' | 'C' | 'D' | null };

/** Название и категория организаций в транзакции сотрудника или системы: условия правил и пробный прогон. */
export async function orgFactsTx(tx: Tx, orgIds: readonly string[]): Promise<Map<string, OrgFacts>> {
  const ids = [...new Set(orgIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ orgId: organizations.orgId, name: organizations.name, category: organizations.category }).from(organizations).where(inArray(organizations.orgId, ids));
  return new Map(rows.map((row) => [row.orgId, { name: row.name, category: row.category }]));
}

/**
 * Организации, по обращениям которых AI-сотрудник получает события (веха M8b, решения 6 и 26): клиенты с включённой
 * AI-обработкой, без служебной "Неопознанные". Категория для тела события; названия в результате нет.
 */
export async function agentEventOrgsTx(tx: Tx, orgIds: readonly string[]): Promise<Map<string, { category: 'A' | 'B' | 'C' | 'D' | null }>> {
  const ids = [...new Set(orgIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ orgId: organizations.orgId, category: organizations.category, kind: organizations.kind, isAiEnabled: organizations.isAiEnabled })
    .from(organizations)
    .where(inArray(organizations.orgId, ids));
  return new Map(rows.filter((row) => row.kind === 'client' && row.isAiEnabled && row.orgId !== SERVICE_ORG_ID).map((row) => [row.orgId, { category: row.category }]));
}
