import { expect, test } from 'vitest';
import { totp } from '../helpers/totp';

// Проверочные значения из RFC 6238, приложение B (ключ "12345678901234567890" в base32).
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('помощник тестов считает код TOTP как в RFC 6238', () => {
  expect(totp(RFC_SECRET, new Date(59_000))).toBe('287082');
  expect(totp(RFC_SECRET, new Date(1_111_111_109_000))).toBe('081804');
  expect(totp(RFC_SECRET, new Date(1_234_567_890_000))).toBe('005924');
  expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', new Date(59_000))).toBe('287082');
});
