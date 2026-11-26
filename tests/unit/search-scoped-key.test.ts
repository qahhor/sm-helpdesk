import { expect, test } from 'vitest';
import type { ClientActor, StaffActor } from '@/db/with-actor';
import { generateScopedKey, isScopedKey, SCOPED_KEY_TTL_SEC, scopeFor } from '@/modules/hdc/search/scoped-key';

// Ключ с областью (план W6, решение 2; документация Typesense 30.2, api/api-keys): HMAC-SHA256 от вложенных параметров
// ключом поиска, первые 4 знака ключа и сами параметры, всё в base64.

const client: ClientActor = { type: 'client', userId: '00000000-0000-7000-8000-000000000001', orgId: '00000000-0000-7000-8000-0000000000a1', orgRole: 'client_user' };
const staff: StaffActor = { type: 'staff', userId: '00000000-0000-7000-8000-000000000002', staffRole: 'agent_l1' };
const keys = { client: 'client-parent-search-key-0000000001', staff: 'staff-parent-search-key-00000000002' };
const now = new Date('2026-11-26T10:00:00Z');

/** Вложенные параметры ключа: после подписи (44 знака) и первых 4 знаков ключа. */
function embedded(value: string): Record<string, unknown> {
  const raw = Buffer.from(value, 'base64').toString('utf8');
  return JSON.parse(raw.slice(48)) as Record<string, unknown>;
}

test('совпадает с примером документации api/api-keys', () => {
  expect(generateScopedKey('RN23GFr1s6jQ9kgSNg2O7fYcAUXU7127', { filter_by: 'company_id:124', expires_at: 1906054106 })).toBe(
    'OW9DYWZGS1Q1RGdSbmo0S1QrOWxhbk9PL2kxbTU1eXA3bCthdmE5eXJKRT1STjIzeyJmaWx0ZXJfYnkiOiJjb21wYW55X2lkOjEyNCIsImV4cGlyZXNfYXQiOjE5MDYwNTQxMDZ9',
  );
});

test('клиент: организация из актора, обязательные параметры и срок 60 секунд всегда', () => {
  const scope = scopeFor(client, 'tickets', keys, now);
  expect(isScopedKey(scope)).toBe(true);
  expect(scope.collections).toEqual(['tickets']);
  const params = embedded(scope.value);
  expect(params).toEqual({
    filter_by: `org_id:=${client.orgId}`,
    include_fields: 'id',
    highlight_fields: 'none',
    use_cache: false,
    filter_curated_hits: true,
    expires_at: Math.floor(now.getTime() / 1000) + SCOPED_KEY_TTL_SEC,
  });
  expect(SCOPED_KEY_TTL_SEC).toBe(60);
  // Подписан ключом клиента, а не сотрудника.
  expect(Buffer.from(scope.value, 'base64').toString('utf8').slice(44, 48)).toBe(keys.client.slice(0, 4));
});

test('решения: клиенту только clients, сотруднику clients и internal', () => {
  expect(embedded(scopeFor(client, 'solutions', keys, now).value).filter_by).toBe('audience:=clients');
  expect(embedded(scopeFor(staff, 'solutions', keys, now).value).filter_by).toBe('audience:=[clients,internal]');
  expect(Buffer.from(scopeFor(staff, 'solutions', keys, now).value, 'base64').toString('utf8').slice(44, 48)).toBe(keys.staff.slice(0, 4));
});

test('сотрудник ищет обращения и переписку; клиенту переписка и справочники недоступны', () => {
  const scope = scopeFor(staff, 'tickets', keys, now);
  expect(scope.collections).toEqual(['tickets', 'ticket_texts']);
  expect(embedded(scope.value).filter_by).toBeUndefined();
  expect(scopeFor(staff, 'directory', keys, now).collections).toEqual(['orgs', 'people']);
  expect(() => scopeFor(client, 'directory', keys, now)).toThrow();
});

test('идеи: только опубликованные статусы, для всех', () => {
  expect(embedded(scopeFor(client, 'ideas', keys, now).value).filter_by).toBe('status:!=[pending_review,declined,merged]');
  expect(embedded(scopeFor(staff, 'ideas', keys, now).value).filter_by).toBe('status:!=[pending_review,declined,merged]');
});

test('без ключа области нет; AI-сотрудник и система ключа не получают', () => {
  expect(() => scopeFor(client, 'tickets', { client: '', staff: keys.staff }, now)).toThrow();
  expect(() => scopeFor({ type: 'agent', tokenId: 't', tools: [] } as never, 'tickets', keys, now)).toThrow();
  expect(() => scopeFor({ type: 'system', job: 'x' } as never, 'tickets', keys, now)).toThrow();
  // Строка, похожая на ключ, ключом области не считается: функция вызова её не примет.
  expect(isScopedKey({ value: 'abc', purpose: 'tickets', collections: ['tickets'] })).toBe(false);
});
