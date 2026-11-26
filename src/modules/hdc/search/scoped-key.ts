import { createHmac } from 'node:crypto';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import type { EmbeddedParams, ScopedKey, SearchCollection, SearchPurpose } from './types';

// Ключ с областью Typesense (план W6, решение 2; документация 30.2, api/api-keys, раздел Generate Scoped Search Key):
// base64(base64(HMAC-SHA256(ключ поиска, параметры)) + первые 4 знака ключа + параметры). Считается в портале без
// запроса к Typesense на каждый поиск. Вложенные параметры Typesense применяет сам, запрос их не переопределяет:
// фильтр организации и аудитории, только поле id, без отрывков, без кеша выдачи, фильтр и для закреплённых правилом
// курирования документов (filter_curated_hits), срок 60 секунд. Организация берётся только из актора.

/** Срок ключа с областью, секунд. */
export const SCOPED_KEY_TTL_SEC = 60;

/** Статусы идей, которых нет на доске (решение 2 вехи M7): ключ отсекает их, даже если документ ещё не снят. */
export const HIDDEN_IDEA_STATUSES = ['pending_review', 'declined', 'merged'] as const;

/** Родительские ключи поиска: только documents:search. Клиентский не видит переписку и справочники (решение 0070). */
export type ParentSearchKeys = { client: string; staff: string };

const COLLECTIONS: Record<SearchPurpose, readonly SearchCollection[]> = {
  tickets: ['tickets'],
  solutions: ['solutions'],
  ideas: ['ideas'],
  directory: ['orgs', 'people'],
};

/** Ключ, который нельзя подделать литералом: признак ставит только этот модуль. */
const issued = new WeakSet<object>();

/** Ключ с областью по документации: вложенные параметры подписываются родительским ключом поиска. */
export function generateScopedKey(parentKey: string, params: Record<string, unknown>): string {
  const json = JSON.stringify(params);
  const hmac = createHmac('sha256', parentKey).update(json).digest('base64');
  return Buffer.from(`${hmac}${parentKey.slice(0, 4)}${json}`).toString('base64');
}

function filterFor(actor: ClientActor | StaffActor, purpose: SearchPurpose): string | undefined {
  switch (purpose) {
    case 'tickets':
      // Как политика hdt_tickets_client_select: обращения организации, личные только свои, администратору клиента все.
      if (actor.type !== 'client') return undefined;
      return actor.orgRole === 'client_admin' ? `org_id:=${actor.orgId}` : `org_id:=${actor.orgId} && (visibility:=org || author_id:=${actor.userId})`;
    case 'solutions':
      return actor.type === 'client' ? 'audience:=clients' : 'audience:=[clients,internal]';
    case 'ideas':
      return `status:!=[${HIDDEN_IDEA_STATUSES.join(',')}]`;
    case 'directory':
      return undefined;
  }
}

/**
 * Ключ для поиска от имени актора. Клиент получает только обращения своей организации, решения и идеи; сотрудник ещё
 * переписку (коллекция ticket_texts) и справочники. AI-сотрудник и система ключа не получают: их поиск идёт в базе.
 */
export function scopeFor(actor: ClientActor | StaffActor, purpose: SearchPurpose, keys: ParentSearchKeys, now: Date = new Date()): ScopedKey {
  if (actor.type !== 'client' && actor.type !== 'staff') throw new Error('Поиск: ключ с областью выдаётся только клиенту и сотруднику');
  if (actor.type === 'client' && purpose === 'directory') throw new Error('Поиск: справочники организаций и людей клиенту недоступны');
  const parent = actor.type === 'client' ? keys.client : keys.staff;
  if (!parent) throw new Error('Поиск: нет ключа поиска');
  if (actor.type === 'client' && !(/^[0-9a-f-]{36}$/i.test(actor.orgId) && /^[0-9a-f-]{36}$/i.test(actor.userId))) throw new Error('Поиск: организация или пользователь актора не похожи на идентификатор');
  const filter = filterFor(actor, purpose);
  const embedded: EmbeddedParams = {
    ...(filter ? { filter_by: filter } : {}),
    include_fields: 'id',
    highlight_fields: 'none',
    use_cache: false,
    filter_curated_hits: true,
    expires_at: Math.floor(now.getTime() / 1000) + SCOPED_KEY_TTL_SEC,
  };
  const collections = purpose === 'tickets' && actor.type === 'staff' ? (['tickets', 'ticket_texts'] as const) : COLLECTIONS[purpose];
  const key = { value: generateScopedKey(parent, embedded), purpose, collections, embedded } as unknown as ScopedKey;
  issued.add(key);
  return Object.freeze(key);
}

/** Ключ выдан scopeFor. Объект с теми же полями, собранный вручную, ключом не считается. */
export function isScopedKey(value: unknown): value is ScopedKey {
  return typeof value === 'object' && value !== null && issued.has(value);
}
