import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { generateTokenValue, hashToken, ipAllowed, normalizeCidr, parseBearer } from '@/modules/hda/agent/auth';

// Значение токена, разбор заголовка и проверка адреса (веха M8b, задача 3; план M8b, решения 10, 11).

test('значение токена: приставка hub_at_ и 32 случайных байта base64url, каждый раз новое', () => {
  const values = new Set(Array.from({ length: 50 }, () => generateTokenValue()));
  expect(values.size).toBe(50);
  for (const value of values) expect(value).toMatch(/^hub_at_[A-Za-z0-9_-]{43}$/);
});

test('хеш: SHA-256 значения в шестнадцатеричном виде, последние 4 знака отдельно не нужны функции', () => {
  const value = 'hub_at_' + 'a'.repeat(43);
  expect(hashToken(value)).toBe(createHash('sha256').update(value).digest('hex'));
  expect(hashToken(value)).toMatch(/^[0-9a-f]{64}$/);
});

test('разбор заголовка Authorization', () => {
  const value = generateTokenValue();
  expect(parseBearer(`Bearer ${value}`)).toBe(value);
  expect(parseBearer(`bearer ${value}`)).toBe(value);
  expect(parseBearer(`  Bearer   ${value}  `)).toBe(value);
  expect(parseBearer(`Basic ${value}`)).toBeNull();
  expect(parseBearer('Bearer')).toBeNull();
  expect(parseBearer('Bearer ')).toBeNull();
  expect(parseBearer('')).toBeNull();
  expect(parseBearer(null)).toBeNull();
  expect(parseBearer(undefined)).toBeNull();
  // Значение не нашего вида не ищется в базе.
  expect(parseBearer('Bearer abc')).toBeNull();
  expect(parseBearer(`Bearer ${value} extra`)).toBeNull();
  expect(parseBearer(`Bearer ${value}x`)).toBeNull();
});

test('адрес в списке сетей: IPv4, IPv6, сеть /64, адрес с портом, неверный адрес', () => {
  expect(ipAllowed('10.0.3.12', ['10.0.3.12/32'])).toBe(true);
  expect(ipAllowed('10.0.3.13', ['10.0.3.12/32'])).toBe(false);
  expect(ipAllowed('10.0.7.200', ['10.0.0.0/16'])).toBe(true);
  expect(ipAllowed('10.1.0.1', ['10.0.0.0/16'])).toBe(false);
  expect(ipAllowed('2001:db8:1:2::15', ['2001:db8:1:2::/64'])).toBe(true);
  expect(ipAllowed('2001:db8:1:3::15', ['2001:db8:1:2::/64'])).toBe(false);
  expect(ipAllowed('::ffff:10.0.3.12', ['10.0.3.12/32'])).toBe(true);
  // Адрес с портом из заголовка прокси: порт отбрасывается.
  expect(ipAllowed('10.0.3.12:51234', ['10.0.3.12/32'])).toBe(true);
  expect(ipAllowed('[2001:db8:1:2::15]:443', ['2001:db8:1:2::/64'])).toBe(true);
  expect(ipAllowed('not-an-ip', ['0.0.0.0/0'])).toBe(false);
  expect(ipAllowed('', ['0.0.0.0/0'])).toBe(false);
  expect(ipAllowed(null, ['0.0.0.0/0'])).toBe(false);
  expect(ipAllowed('10.0.3.12', [])).toBe(false);
  // Неверная сеть в списке ничего не разрешает.
  expect(ipAllowed('10.0.3.12', ['10.0.3.12/33', 'garbage'])).toBe(false);
});

test('сеть для списка токена: адрес без маски становится /32 или /128, неверное отклоняется', () => {
  expect(normalizeCidr('10.0.3.12')).toBe('10.0.3.12/32');
  expect(normalizeCidr(' 10.0.0.0/16 ')).toBe('10.0.0.0/16');
  expect(normalizeCidr('2001:db8::1')).toBe('2001:db8::1/128');
  expect(normalizeCidr('2001:db8:1:2::/64')).toBe('2001:db8:1:2::/64');
  // Биты адреса за маской база не примет (cidr): сеть приводится к началу.
  expect(normalizeCidr('10.0.3.12/24')).toBe('10.0.3.0/24');
  expect(normalizeCidr('10.0.3.12/33')).toBeNull();
  expect(normalizeCidr('2001:db8::/129')).toBeNull();
  expect(normalizeCidr('300.1.1.1')).toBeNull();
  expect(normalizeCidr('')).toBeNull();
  expect(normalizeCidr('example.com')).toBeNull();
});
