import { afterEach, expect, test, vi } from 'vitest';
import { freshTotp, totp } from '../helpers/totp';

// Помощник тестов: каждый вход сотрудника получает код, который портал ещё не принимал (проверка main, S11).
// Раньше шаги брались относительно момента вызова, и при переходе через границу 30 секунд код повторялся.

afterEach(() => vi.useRealTimers());

// Проверочные значения из RFC 6238, приложение B (ключ "12345678901234567890" в base32).
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('помощник тестов считает код TOTP как в RFC 6238', () => {
  expect(totp(RFC_SECRET, new Date(59_000))).toBe('287082');
  expect(totp(RFC_SECRET, new Date(1_111_111_109_000))).toBe('081804');
  expect(totp(RFC_SECRET, new Date(1_234_567_890_000))).toBe('005924');
  expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', new Date(59_000))).toBe('287082');
});

const SECRET = 'JBSWY3DPEHPK3PXP';

test('два входа по разные стороны границы шага получают разные коды', () => {
  vi.useFakeTimers();
  // За 100 мс до конца шага и через 100 мс после.
  vi.setSystemTime(new Date(30_000 * 1_000_000 - 100));
  const first = freshTotp(SECRET);
  vi.setSystemTime(new Date(30_000 * 1_000_000 + 100));
  const second = freshTotp(SECRET);
  expect(second).not.toBe(first);
});

test('коды берутся из шагов, которые библиотека ещё примет: текущий, затем следующий, затем предыдущий', () => {
  vi.useFakeTimers();
  const at = new Date(30_000 * 2_000_000 + 15_000);
  vi.setSystemTime(at);
  const secret = 'KRSXG5CTMVRXEZLU';
  const codes = [freshTotp(secret), freshTotp(secret), freshTotp(secret)];
  expect(codes).toEqual([totp(secret, at), totp(secret, new Date(at.getTime() + 30_000)), totp(secret, new Date(at.getTime() - 30_000))]);
  expect(() => freshTotp(secret)).toThrow();
});
