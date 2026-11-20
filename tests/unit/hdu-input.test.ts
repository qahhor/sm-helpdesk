import { expect, test } from 'vitest';
import { emailInput, nameInput, passwordInput, staffRoleInput, tokenInput, totpCodeInput, uuidInput } from '@/modules/hdu/input';
import { hashToken, newToken } from '@/modules/hdu/tokens';

test('email приводится к одному виду', () => {
  expect(emailInput.parse('  Admin@Smartup.Example ')).toBe('admin@smartup.example');
  for (const bad of ['not-an-email', 'a@b', '@smartup.example', 'a b@smartup.example', '', `${'a'.repeat(250)}@x.example`, 42, null])
    expect(emailInput.safeParse(bad).success, String(bad)).toBe(false);
});

test('пароль не короче 12 и не длиннее 128 знаков', () => {
  expect(passwordInput.safeParse('short-11chr').success).toBe(false);
  expect(passwordInput.safeParse('exactly-12ch').success).toBe(true);
  expect(passwordInput.safeParse('x'.repeat(128)).success).toBe(true);
  expect(passwordInput.safeParse('x'.repeat(129)).success).toBe(false);
  // Пробелы по краям пароля не обрезаются: это часть пароля.
  expect(passwordInput.parse('  twelve chars ')).toBe('  twelve chars ');
});

test('имя, код второго фактора, токен ссылки, идентификатор и роль проверяются по образцу', () => {
  expect(nameInput.parse('  Камила  ')).toBe('Камила');
  expect(nameInput.safeParse('   ').success).toBe(false);
  expect(nameInput.safeParse('я'.repeat(121)).success).toBe(false);
  expect(totpCodeInput.parse(' 123456 ')).toBe('123456');
  for (const bad of ['12345a', '12345', '1234567', '', 123456]) expect(totpCodeInput.safeParse(bad).success, String(bad)).toBe(false);
  expect(tokenInput.safeParse('a'.repeat(43)).success).toBe(true);
  for (const bad of ['a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`, '']) expect(tokenInput.safeParse(bad).success).toBe(false);
  expect(uuidInput.safeParse('019a1111-1111-7111-8111-111111111111').success).toBe(true);
  expect(uuidInput.safeParse('not-a-uuid').success).toBe(false);
  expect(staffRoleInput.safeParse('care').success).toBe(true);
  expect(staffRoleInput.safeParse('agent_bot').success).toBe(false);
  expect(staffRoleInput.safeParse('client_admin').success).toBe(false);
});

test('токен ссылки случайный и хранится только хешем', () => {
  const { token, hash } = newToken();
  expect(token).toMatch(/^[\w-]{43}$/);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(hashToken(token)).toBe(hash);
  expect(newToken().token).not.toBe(token);
  expect(tokenInput.safeParse(token).success).toBe(true);
});
