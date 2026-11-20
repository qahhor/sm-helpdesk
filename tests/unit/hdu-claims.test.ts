import { expect, test } from 'vitest';
import { smartupProfile } from '@/modules/hdu/core/claims';
import { isSyntheticEmail, syntheticEmail } from '@/modules/hdu/util';

test('сведения из Smartup проверяются, пустые строки считаются отсутствием, числа становятся строками', () => {
  expect(smartupProfile.parse({ id: '1001', name: 'Алишер', companyId: '501', companyName: 'ACME Trade', contactEmail: '', inn: '' })).toEqual({
    id: '1001',
    name: 'Алишер',
    companyId: '501',
    companyName: 'ACME Trade',
  });
  expect(smartupProfile.parse({ id: 1001, name: ' Алишер ', companyId: 501, companyName: 'ACME', inn: 301234567 })).toEqual({
    id: '1001',
    name: 'Алишер',
    companyId: '501',
    companyName: 'ACME',
    inn: '301234567',
  });
  // Лишние поля отбрасываются: портал берёт из Smartup только то, что перечислено.
  expect(smartupProfile.parse({ id: '1', name: 'x', companyId: '1', companyName: 'x', email: '1', isAdmin: true })).not.toHaveProperty('isAdmin');
});

test('сведения без компании и со слишком длинными значениями не принимаются', () => {
  expect(smartupProfile.safeParse({ id: '1001', name: 'Алишер' }).success).toBe(false);
  expect(smartupProfile.safeParse({ id: '1001', name: 'Алишер', companyId: '', companyName: 'ACME' }).success).toBe(false);
  expect(smartupProfile.safeParse({ id: '1001', name: 'x', companyId: '5'.repeat(201), companyName: 'x' }).success).toBe(false);
  expect(smartupProfile.safeParse({ id: '1001', name: 'x', companyId: '5', companyName: 'я'.repeat(301) }).success).toBe(false);
  expect(smartupProfile.safeParse({ id: '1001', name: 'x', companyId: '5', companyName: 'x', contactEmail: 'не адрес' }).success).toBe(true);
  expect(smartupProfile.parse({ id: '1001', name: 'x', companyId: '5', companyName: 'x', contactEmail: 'не адрес' })).not.toHaveProperty('contactEmail');
});

test('служебный адрес нельзя спутать с настоящим', () => {
  expect(isSyntheticEmail(syntheticEmail())).toBe(true);
  expect(syntheticEmail()).toMatch(/^u-[0-9a-f-]{36}@users\.invalid$/);
  expect(isSyntheticEmail('person@users.invalid.example')).toBe(false);
  expect(isSyntheticEmail('person@example.test')).toBe(false);
  expect(syntheticEmail()).not.toBe(syntheticEmail());
});
