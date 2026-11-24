import { expect, test } from 'vitest';
import { csatToken, parseCsatToken } from '@/modules/hdt/csat-link';
import { replyAddress } from '@/modules/hdn/inbound/reply-address';

// Ссылка оценки из письма (FR-TK-11, UX-C-07; план W3, задача 1). Подпись привязывает ссылку к обращению и автору:
// без входа в портал по ней можно только поставить оценку этому обращению.

const SECRET = 'reply-secret-of-at-least-32-chars!!';
const OLD = 'previous-secret-of-at-least-32-chars';
const USER = '01a20ab0-3c68-79e2-a4ae-1a2ec7e60c17';
const OTHER = '01a20ab0-3c68-79e2-a4ae-1a2ec7e60c18';

test('подпись проверяется: номер и автор читаются только из неизменённой ссылки', () => {
  const token = csatToken(1042, USER, SECRET);
  expect(token).toMatch(/^[0-9a-f.]+$/);
  expect(parseCsatToken(token, [SECRET])).toEqual({ number: 1042, userId: USER });
  // Любая правка ломает подпись: другой номер, другой пользователь, обрезка.
  expect(parseCsatToken(token.replace(/^1042\./, '1043.'), [SECRET])).toBeNull();
  expect(parseCsatToken(csatToken(1042, OTHER, SECRET).replace(OTHER.replaceAll('-', ''), USER.replaceAll('-', '')), [SECRET])).toBeNull();
  expect(parseCsatToken(token.slice(0, -1), [SECRET])).toBeNull();
  expect(parseCsatToken(`${token}0`, [SECRET])).toBeNull();
  for (const bad of ['', 'abc', '1042', '1042..', '0.x.y', `${'9'.repeat(30)}.${USER.replaceAll('-', '')}.${'a'.repeat(32)}`]) expect(parseCsatToken(bad, [SECRET]), bad).toBeNull();
});

test('другой ключ ссылку не открывает; прежний ключ действует, пока он задан', () => {
  const token = csatToken(7, USER, OLD);
  expect(parseCsatToken(token, [SECRET])).toBeNull();
  expect(parseCsatToken(token, [SECRET, OLD])).toEqual({ number: 7, userId: USER });
  expect(parseCsatToken(token, [])).toBeNull();
});

test('подпись адреса ответа ссылкой оценки не становится', () => {
  // Адрес ответа виден в пересланном письме: его подпись тем же ключом не должна открывать оценку.
  const address = replyAddress(1042, USER, { domain: 'reply.example.test', secret: SECRET });
  const signature = /\.([0-9a-f]+)@/.exec(address)?.[1] ?? '';
  expect(signature.length).toBeGreaterThan(0);
  expect(parseCsatToken(`1042.${USER.replaceAll('-', '')}.${signature.padEnd(32, '0')}`, [SECRET])).toBeNull();
  expect(csatToken(1042, USER, SECRET)).not.toContain(signature);
});
