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
