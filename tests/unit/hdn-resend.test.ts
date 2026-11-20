import { expect, test, vi } from 'vitest';
import type { MailMessage } from '@/modules/hdn/mailer';
import { createResendMailer, MailError } from '@/modules/hdn/resend';

// Настоящая отправка писем входа через Resend (решение 0018, пункт 17): сразу, без очереди, с двумя повторами.

const mail: MailMessage = { to: 'person@example.test', subject: 'Вход в Smartup Hub', text: 'https://hub/ru/login/link?token=abc', kind: 'login-link' };
const ok = () => new Response(JSON.stringify({ id: 'r1' }), { status: 200 });
const make = (fetch: typeof globalThis.fetch) =>
  createResendMailer({ apiKey: 're_secret_key', from: 'Smartup Hub <hub@mail.smartup24.com>', fetch, timeoutMs: 50, pausesMs: [0, 0] });
type Init = { headers: Record<string, string>; body: string; method: string };

test('письмо уходит одним запросом с адресом отправителя из настроек', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => ok());
  await make(fetch).send(mail);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, Init];
  expect(url).toBe('https://api.resend.com/emails');
  expect(init.method).toBe('POST');
  expect(init.headers.Authorization).toBe('Bearer re_secret_key');
  expect(init.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body)).toEqual({ from: 'Smartup Hub <hub@mail.smartup24.com>', to: ['person@example.test'], subject: mail.subject, text: mail.text });
});

test('сбой сервиса повторяется дважды с тем же ключом повторной отправки', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockRejectedValueOnce(new Error('сеть'))
    .mockResolvedValueOnce(ok());
  await make(fetch).send(mail);
  expect(fetch).toHaveBeenCalledTimes(3);
  const keys = fetch.mock.calls.map((call) => (call[1] as unknown as Init).headers['Idempotency-Key']);
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
});

test('ответ 429 повторяется, у разных писем разные ключи', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValue(ok());
  const mailer = make(fetch);
  await mailer.send(mail);
  await mailer.send(mail);
  expect(fetch).toHaveBeenCalledTimes(3);
  const keys = fetch.mock.calls.map((call) => (call[1] as unknown as Init).headers['Idempotency-Key']);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[2]).not.toBe(keys[0]);
});

test('ошибка запроса не повторяется, после трёх неудач письмо считается неотправленным', async () => {
  const bad = vi.fn<typeof globalThis.fetch>(async () => new Response('{"message":"invalid from"}', { status: 422 }));
  await expect(make(bad).send(mail)).rejects.toMatchObject({ status: 422 });
  expect(bad).toHaveBeenCalledTimes(1);
  const down = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 500 }));
  await expect(make(down).send(mail)).rejects.toBeInstanceOf(MailError);
  expect(down).toHaveBeenCalledTimes(3);
  const slow = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}));
  await expect(make(slow).send(mail)).rejects.toMatchObject({ status: null });
  expect(slow).toHaveBeenCalledTimes(3);
});

test('ключ, адрес и ссылка не попадают в сообщение об ошибке и в журнал', async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((line) => void lines.push(String(line)));
  const error = await make(vi.fn<typeof globalThis.fetch>(async () => new Response('{"message":"person@example.test"}', { status: 500 })))
    .send(mail)
    .catch((e: unknown) => e);
  spy.mockRestore();
  expect(error).toBeInstanceOf(MailError);
  expect(lines.join('\n')).toContain('login-link');
  for (const secret of ['re_secret_key', 'person@example.test', 'token=abc', 'Вход в Smartup Hub']) {
    expect(String((error as Error).message)).not.toContain(secret);
    expect(lines.join('\n')).not.toContain(secret);
  }
});
