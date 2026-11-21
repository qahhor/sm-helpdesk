import { expect, test } from 'vitest';
import { ENCRYPTED_OFFICE_SIGNATURE } from '@/modules/hdt/pref';
import { rejectReasonOf, typeMatches } from '@/modules/hdt/util';

// Файл, который нельзя проверить, не принимается с понятной причиной (решение 0027, пункт 20).

test('причина отказа по подписи антивируса: зашифрованный файл и файл сверх пределов проверки', () => {
  // Имена подписей проверены на clamav/clamav:1.5.5 с параметрами из compose.prod.yaml.
  expect(rejectReasonOf('Heuristics.Encrypted.Zip')).toBe('encrypted');
  expect(rejectReasonOf('Heuristics.Encrypted.PDF')).toBe('encrypted');
  expect(rejectReasonOf(ENCRYPTED_OFFICE_SIGNATURE)).toBe('encrypted');
  expect(rejectReasonOf('Heuristics.Limits.Exceeded.MaxFiles')).toBe('limits');
  expect(rejectReasonOf('Heuristics.Limits.Exceeded.MaxRecursion')).toBe('limits');
  // Настоящая находка и прочие эвристики остаются заражением, а не отказом.
  for (const signature of ['Eicar-Test-Signature', 'Win.Trojan.Agent-1', 'Heuristics.Phishing.Email.SpoofedDomain', 'Heuristics.EncryptedX', null])
    expect(rejectReasonOf(signature), String(signature)).toBeNull();
});

test('документ Office нового формата принимается только как ZIP: с паролем он лежит в контейнере OLE', () => {
  for (const mime of [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]) {
    expect(typeMatches(mime, 'zip'), mime).toBe(true);
    expect(typeMatches(mime, 'ole'), mime).toBe(false);
  }
  // Старые doc, xls, ppt и есть OLE.
  expect(typeMatches('application/vnd.ms-excel', 'ole')).toBe(true);
});
