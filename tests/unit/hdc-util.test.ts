import { expect, test } from 'vitest';
import { AUDIT_ACTIONS, RATE_RULES } from '@/modules/hdc/pref';
import { clientIp } from '@/modules/hdc/util';

test('адрес посетителя берётся из первого значения заголовка и проверяется', () => {
  expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  expect(clientIp(new Headers({ 'x-forwarded-for': ' 203.0.113.7 ' }))).toBe('203.0.113.7');
  expect(clientIp(new Headers({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
  expect(clientIp(new Headers({ 'x-forwarded-for': 'drop table' }))).toBeNull();
  expect(clientIp(new Headers({ 'x-forwarded-for': '' }))).toBeNull();
  expect(clientIp(new Headers())).toBeNull();
});

test('пределы частоты взяты из раздела 14.5 ТЗ', () => {
  expect(RATE_RULES.loginLinkPerAddress).toEqual({ limit: 5, windowSec: 3600 });
  expect(RATE_RULES.loginLinkPerIp).toEqual({ limit: 20, windowSec: 3600 });
  expect(RATE_RULES.staffLoginPerAccount).toEqual({ limit: 10, windowSec: 900 });
});

test('действия журнала аудита названы по образцу "объект.действие" и не повторяются', () => {
  expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z]+\.[a-z_]+$/);
  for (const needed of ['staff.created', 'server.added', 'member.role_changed', 'invitation.created', 'user.email_confirmed'])
    expect(AUDIT_ACTIONS).toContain(needed);
});
