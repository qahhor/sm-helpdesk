import { expect, test } from 'vitest';
import { createSecretBox } from '@/security/secret-box';

const box = createSecretBox(Buffer.alloc(32, 1));

test('строка расшифровывается с тем же контекстом', () => {
  expect(box.open(box.seal('s3cr3t', 'hdu_servers:cloud'), 'hdu_servers:cloud')).toBe('s3cr3t');
  expect(box.open(box.seal('', 'c'), 'c')).toBe('');
  expect(box.open(box.seal('секрет с кириллицей', 'c'), 'c')).toBe('секрет с кириллицей');
});

test('одно и то же значение шифруется по-разному и не видно в результате', () => {
  const a = box.seal('s3cr3t', 'c');
  const b = box.seal('s3cr3t', 'c');
  expect(a).not.toBe(b);
  expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/);
  expect(a).not.toContain('s3cr3t');
});

test('чужой контекст, чужой ключ и изменённая строка отклоняются', () => {
  const sealed = box.seal('s3cr3t', 'hdu_servers:cloud');
  expect(() => box.open(sealed, 'hdu_servers:other')).toThrow();
  expect(() => createSecretBox(Buffer.alloc(32, 2)).open(sealed, 'hdu_servers:cloud')).toThrow();
  expect(() => box.open(`${sealed.slice(0, -2)}AA`, 'hdu_servers:cloud')).toThrow();
  expect(() => box.open('v2.a.b.c', 'hdu_servers:cloud')).toThrow();
  expect(() => box.open('не та строка', 'hdu_servers:cloud')).toThrow();
});

test('сообщение об ошибке не раскрывает секрет и ключ', () => {
  const sealed = box.seal('s3cr3t', 'c');
  try {
    box.open(sealed, 'other');
    expect.unreachable('ожидалась ошибка');
  } catch (e) {
    expect(String(e)).not.toContain('s3cr3t');
    expect(String(e)).not.toContain(sealed);
  }
});

test('ключ не той длины отклоняется', () => {
  expect(() => createSecretBox(Buffer.alloc(16))).toThrow();
  expect(() => createSecretBox(Buffer.alloc(33))).toThrow();
});

// --- Замена ключа (аудит 23.11.2026, находка S6; план W1, задача 7) ---

test('замена ключа: значение, зашифрованное прежним ключом, читается, новое шифруется новым', () => {
  const oldKey = Buffer.alloc(32, 1);
  const newKey = Buffer.alloc(32, 2);
  const sealedOld = createSecretBox(oldKey).seal('s3cr3t', 'c');
  const rotated = createSecretBox(newKey, [oldKey]);
  expect(rotated.open(sealedOld, 'c')).toBe('s3cr3t');
  // Новое значение шифруется текущим ключом: коробка только с прежним ключом его не откроет.
  const sealedNew = rotated.seal('другое', 'c');
  expect(() => createSecretBox(oldKey).open(sealedNew, 'c')).toThrow();
  expect(createSecretBox(newKey).open(sealedNew, 'c')).toBe('другое');
});

test('needsReseal говорит, что значение зашифровано прежним ключом; reseal перешифровывает текущим', () => {
  const oldKey = Buffer.alloc(32, 1);
  const newKey = Buffer.alloc(32, 2);
  const rotated = createSecretBox(newKey, [oldKey]);
  const sealedOld = createSecretBox(oldKey).seal('s3cr3t', 'c');
  expect(rotated.needsReseal(sealedOld, 'c')).toBe(true);
  const resealed = rotated.reseal(sealedOld, 'c');
  expect(rotated.needsReseal(resealed, 'c')).toBe(false);
  expect(createSecretBox(newKey).open(resealed, 'c')).toBe('s3cr3t');
  // Чужой контекст и чужой ключ по-прежнему отклоняются.
  expect(() => rotated.open(sealedOld, 'other')).toThrow();
  expect(() => rotated.needsReseal(createSecretBox(Buffer.alloc(32, 9)).seal('x', 'c'), 'c')).toThrow();
});
