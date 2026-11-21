import { expect, test } from 'vitest';
import { claimIssues, smartupProfile } from '@/modules/hdu/core/claims';
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

test('сведения без компании и со слишком длинным идентификатором не принимаются', () => {
  expect(smartupProfile.safeParse({ id: '1001', name: 'Алишер' }).success).toBe(false);
  expect(smartupProfile.safeParse({ id: '1001', name: 'Алишер', companyId: '', companyName: 'ACME' }).success).toBe(false);
  expect(smartupProfile.safeParse({ id: '1001', name: 'x', companyId: '5'.repeat(201), companyName: 'x' }).success).toBe(false);
  expect(smartupProfile.safeParse({ id: '1001', name: 'x', companyId: '5', companyName: 'x', contactEmail: 'не адрес' }).success).toBe(true);
  expect(smartupProfile.parse({ id: '1001', name: 'x', companyId: '5', companyName: 'x', contactEmail: 'не адрес' })).not.toHaveProperty('contactEmail');
});

test('неверное необязательное поле не лишает человека организации, длинное название обрезается (проверка main, Q1)', () => {
  const base = { id: '1001', name: 'Алишер', companyId: '501', companyName: 'ACME Trade' };
  expect(smartupProfile.parse({ ...base, role: 'r'.repeat(500), locale: { bad: true }, inn: 'x'.repeat(80) })).toEqual(base);
  expect(smartupProfile.parse({ ...base, role: 'director', locale: 'uz-UZ' })).toEqual({ ...base, role: 'director', locale: 'uz-UZ' });
  const long = smartupProfile.parse({ ...base, name: 'А'.repeat(250), companyName: 'я'.repeat(400) });
  expect(long.name).toBe('А'.repeat(200));
  expect(long.companyName).toBe('я'.repeat(300));
});

test('журнал называет поля, которые не прошли проверку, без их значений (проверка main, Q1)', () => {
  expect(claimIssues({ id: '1001', name: 'Алишер', companyId: '', companyName: 7 })).toEqual(['companyId']);
  expect(claimIssues({ name: 'x' })).toEqual(['id', 'companyId', 'companyName']);
  expect(claimIssues({ id: '1', name: 'x', companyId: '5', companyName: 'x' })).toEqual([]);
});

test('служебный адрес нельзя спутать с настоящим', () => {
  expect(isSyntheticEmail(syntheticEmail())).toBe(true);
  expect(syntheticEmail()).toMatch(/^u-[0-9a-f-]{36}@users\.invalid$/);
  expect(isSyntheticEmail('person@users.invalid.example')).toBe(false);
  expect(isSyntheticEmail('person@example.test')).toBe(false);
  expect(syntheticEmail()).not.toBe(syntheticEmail());
});
