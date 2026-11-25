import { expect, test, vi } from 'vitest';
import { requestWithRenewal } from '@/ui/widget/session';

// Токен виджета истёк, пока компьютер спал: таймер продления не сработал, первый запрос получает 401. Запрос ждёт
// следующий токен и повторяется один раз (замечание M5 проверки M6, решение 0061).

const status = (code: number) => new Response(null, { status: code });

test('401: новый токен у хозяина, один повтор с ним', async () => {
  const send = vi.fn(async (token: string | null) => status(token === 'fresh' ? 201 : 401));
  const renew = vi.fn(async () => 'fresh');
  const response = await requestWithRenewal(send, 'stale', renew);
  expect(response.status).toBe(201);
  expect(send.mock.calls.map(([token]) => token)).toEqual(['stale', 'fresh']);
  expect(renew).toHaveBeenCalledTimes(1);
});

test('повтор только один: второй 401 возвращается странице как есть', async () => {
  const send = vi.fn(async () => status(401));
  const renew = vi.fn(async () => 'fresh');
  expect((await requestWithRenewal(send, 'stale', renew)).status).toBe(401);
  expect(send).toHaveBeenCalledTimes(2);
  expect(renew).toHaveBeenCalledTimes(1);
});

test('нового токена нет: ответ 401 без повтора; другие ответы без продления', async () => {
  const send = vi.fn(async () => status(401));
  expect((await requestWithRenewal(send, 'stale', async () => null)).status).toBe(401);
  expect(send).toHaveBeenCalledTimes(1);
  const ok = vi.fn(async () => status(200));
  const renew = vi.fn(async () => 'fresh');
  expect((await requestWithRenewal(ok, 'live', renew)).status).toBe(200);
  expect(renew).not.toHaveBeenCalled();
});
