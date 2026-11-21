import { expect, test } from 'vitest';
import { AUDIT_ACTIONS, RATE_RULES } from '@/modules/hdc/pref';
import { clientIp, ipBucket, ipRateKey } from '@/modules/hdc/util';

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

test('адрес посетителя берётся из настроенного заголовка: за Cloudflare это cf-connecting-ip (итоговая проверка, I1)', () => {
  const headers = new Headers({ 'x-forwarded-for': '198.51.100.9, 172.70.1.1', 'cf-connecting-ip': '203.0.113.44', 'x-real-ip': '203.0.113.55' });
  expect(clientIp(headers, 'cf-connecting-ip')).toBe('203.0.113.44');
  expect(clientIp(headers, 'x-real-ip')).toBe('203.0.113.55');
  expect(clientIp(headers, 'x-forwarded-for')).toBe('198.51.100.9');
  // Подделанный x-forwarded-for при настройке cf-connecting-ip ничего не меняет.
  expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.1' }), 'cf-connecting-ip')).toBeNull();
  expect(clientIp(new Headers({ 'cf-connecting-ip': 'not-an-address' }), 'cf-connecting-ip')).toBeNull();
});

test('адрес для счётчиков: IPv4 целиком, IPv6 по сети /64, без адреса общий ключ (проверка main, S6)', () => {
  expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
  expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
  expect(ipBucket('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
  expect(ipBucket('2001:DB8:0001:0002:ffff::1')).toBe('2001:db8:1:2::/64');
  expect(ipBucket('::ffff:198.51.100.4')).toBe('198.51.100.4');
  expect(ipBucket(null)).toBe('unknown');
  expect(ipRateKey('login-link:ip', new Headers({ 'x-forwarded-for': '2001:db8:1:2::1' }), 'x-forwarded-for')).toBe(
    ipRateKey('login-link:ip', new Headers({ 'x-forwarded-for': '2001:db8:1:2:aaaa::2' }), 'x-forwarded-for'),
  );
});
