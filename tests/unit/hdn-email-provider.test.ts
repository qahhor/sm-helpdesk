import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { parseMailbox, WebhookSignatureError } from '@/modules/hdn/provider';
import { createResendProvider, MailError } from '@/modules/hdn/resend';
import { createMemoryEmailProvider } from '@/modules/hdn/testing';

// Почтовый сервис вехи M4 (раздел 11.11, решения 10 и 20): отправка писем очереди, проверка подписи вебхука,
// письмо и вложения забираются отдельными запросами (вебхук Resend несёт только сведения о письме).

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '../fixtures/resend', name), 'utf8');
const key = Buffer.alloc(24, 5).toString('base64');
const webhookSecret = `whsec_${key}`;
type Init = { headers: Record<string, string>; body?: string; method?: string };

function signed(body: string, secretKey = key): Headers {
  const id = 'msg_test';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', Buffer.from(secretKey, 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return new Headers({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` });
}

const make = (fetch: typeof globalThis.fetch, downloadHosts: string[] = ['example.test']) =>
  createResendProvider({ apiKey: 're_key', from: 'Smartup Hub <hub@mail.example.test>', webhookSecret, fetch, timeoutMs: 50, pausesMs: [0, 0], downloadHosts });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('email.received из образца даёт received без текста письма', async () => {
  const body = fixture('email-received.json');
  const event = await make(vi.fn()).verifyWebhook(body, signed(body));
  expect(event).toEqual({
    kind: 'received',
    emailId: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
    from: 'Ivan Petrov <ivan@example.uz>',
    to: ['support@reply.example.test'],
    cc: ['Ali <ali@example.uz>'],
    subject: 'Не могу войти',
    messageId: '<CAJ1234@mail.example.uz>',
    receivedAt: new Date('2026-11-22T10:15:29.000Z'),
  });
  expect(JSON.stringify(event)).not.toContain('Добрый день');
});

test('событие доставки email.bounced даёт delivery bounced с причиной', async () => {
  const body = fixture('email-bounced.json');
  expect(await make(vi.fn()).verifyWebhook(body, signed(body))).toEqual({
    kind: 'delivery',
    emailId: '56761188-7520-42d8-8898-ff6fc54ce618',
    status: 'bounced',
    reason: 'Mailbox does not exist',
  });
  const delivered = JSON.stringify({ type: 'email.delivered', created_at: '2026-11-22T10:00:00Z', data: { email_id: 'x1' } });
  expect(await make(vi.fn()).verifyWebhook(delivered, signed(delivered))).toEqual({ kind: 'delivery', emailId: 'x1', status: 'delivered', reason: null });
  const delayed = JSON.stringify({ type: 'email.delivery_delayed', created_at: '2026-11-22T10:00:00Z', data: { email_id: 'x2' } });
  expect(await make(vi.fn()).verifyWebhook(delayed, signed(delayed))).toMatchObject({ status: 'delayed' });
});

test('неизвестный тип события даёт ignored', async () => {
  const body = JSON.stringify({ type: 'contact.created', created_at: '2026-11-22T10:00:00Z', data: {} });
  expect(await make(vi.fn()).verifyWebhook(body, signed(body))).toEqual({ kind: 'ignored', type: 'contact.created' });
});

test('неверная подпись и чужой секрет бросают WebhookSignatureError, тело не по схеме бросает ошибку разбора', async () => {
  const body = fixture('email-received.json');
  await expect(make(vi.fn()).verifyWebhook(body, signed(body, Buffer.alloc(24, 6).toString('base64')))).rejects.toBeInstanceOf(WebhookSignatureError);
  await expect(make(vi.fn()).verifyWebhook(body, new Headers())).rejects.toBeInstanceOf(WebhookSignatureError);
  const broken = JSON.stringify({ type: 'email.received', data: { from: 'x' } });
  await expect(make(vi.fn()).verifyWebhook(broken, signed(broken))).rejects.not.toBeInstanceOf(WebhookSignatureError);
});

test('заголовки списком и объектом дают одинаковый список пар', async () => {
  const asObject = JSON.parse(fixture('received-email.json'));
  const asList = { ...asObject, headers: Object.entries(asObject.headers).map(([name, value]) => ({ name, value })) };
  const fetchObject = vi.fn<typeof globalThis.fetch>(async () => json(asObject));
  const fetchList = vi.fn<typeof globalThis.fetch>(async () => json(asList));
  const a = await make(fetchObject).fetchInbound('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
  const b = await make(fetchList).fetchInbound('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
  expect(a).toEqual(b);
  expect(a.text).toBe('Добрый день');
  expect(a.html).toBe('<p>Добрый день</p>');
  expect(a.headers).toContainEqual(['Message-ID', '<CAJ1234@mail.example.uz>']);
  const [url, init] = fetchObject.mock.calls[0] as unknown as [string, Init];
  expect(url).toBe('https://api.resend.com/emails/receiving/4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
  expect(init.headers.Authorization).toBe('Bearer re_key');
});

test('идентификатор письма с недопустимыми знаками не уходит в адрес запроса', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(make(fetch).fetchInbound('../emails?x=1')).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

test('вложения письма: имя, тип, размер, inline и ссылка на скачивание', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(JSON.parse(fixture('received-attachments.json'))));
  expect(await make(fetch).listInboundAttachments('4ef9a417-02e9-4d39-ad75-9611e0fcc33c')).toEqual([
    {
      id: '2a0c9ce0-3112-4728-976e-47ddcd16a318',
      filename: 'screen.png',
      contentType: 'image/png',
      size: 4096,
      contentId: 'img1',
      disposition: 'inline',
      downloadUrl: 'https://inbound-cdn.example.test/attachments/2a0c9ce0?signature=abc',
    },
  ]);
  expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://api.resend.com/emails/receiving/4ef9a417-02e9-4d39-ad75-9611e0fcc33c/attachments');
});

test('скачивание вложения: только https и не больше предела', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new Uint8Array(10)));
  expect((await make(fetch).download('https://cdn.example.test/a', 10)).byteLength).toBe(10);
  await expect(make(fetch).download('https://cdn.example.test/a', 9)).rejects.toThrow();
  await expect(make(fetch).download('http://cdn.example.test/a', 10)).rejects.toThrow();
});

test('send передаёт reply_to, headers и Idempotency-Key', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ id: 'resend-1' }));
  const result = await make(fetch).send(
    {
      to: 'client@example.uz',
      subject: '[SUP-1042] Ответ поддержки',
      html: '<p>Ответ</p>',
      text: 'Ответ',
      replyTo: 'reply+1042.abc.def@reply.example.test',
      headers: { 'Auto-Submitted': 'auto-generated', 'Message-ID': '<o1@reply.example.test>' },
    },
    'outbox-1',
  );
  expect(result).toEqual({ providerId: 'resend-1' });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, Init];
  expect(url).toBe('https://api.resend.com/emails');
  expect(init.headers['Idempotency-Key']).toBe('outbox-1');
  expect(JSON.parse(init.body ?? '')).toEqual({
    from: 'Smartup Hub <hub@mail.example.test>',
    to: ['client@example.uz'],
    subject: '[SUP-1042] Ответ поддержки',
    html: '<p>Ответ</p>',
    text: 'Ответ',
    reply_to: 'reply+1042.abc.def@reply.example.test',
    headers: { 'Auto-Submitted': 'auto-generated', 'Message-ID': '<o1@reply.example.test>' },
  });
});

test('send: сбой сервиса повторяется с тем же ключом, ошибка запроса не повторяется', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(json({ id: 'r2' }));
  await make(fetch).send({ to: 'a@example.uz', subject: 's', html: 'h', text: 't' }, 'k1');
  expect(fetch).toHaveBeenCalledTimes(2);
  const bad = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 422 }));
  await expect(make(bad).send({ to: 'a@example.uz', subject: 's', html: 'h', text: 't' }, 'k2')).rejects.toThrow();
  expect(bad).toHaveBeenCalledTimes(1);
});

test('адрес отправителя: имя и адрес, только адрес, адрес в скобках, мусор', () => {
  expect(parseMailbox('Ivan Petrov <Ivan@Example.UZ>')).toEqual({ address: 'ivan@example.uz', name: 'Ivan Petrov' });
  expect(parseMailbox('"Петров, Иван" <ivan@example.uz>')).toEqual({ address: 'ivan@example.uz', name: 'Петров, Иван' });
  expect(parseMailbox('ivan@example.uz')).toEqual({ address: 'ivan@example.uz', name: null });
  expect(parseMailbox('<ivan@example.uz>')).toEqual({ address: 'ivan@example.uz', name: null });
  expect(parseMailbox('не адрес')).toBeNull();
  expect(parseMailbox('a@b@c.uz')).toBeNull();
});

test('заглушка: подписанный запрос проходит проверку, письма и входящие видны тесту', async () => {
  const provider = createMemoryEmailProvider();
  const { body, headers } = provider.signedRequest({ type: 'email.received', created_at: '2026-11-22T10:00:00Z', data: JSON.parse(fixture('email-received.json')).data });
  expect(await provider.verifyWebhook(body, headers)).toMatchObject({ kind: 'received', emailId: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c' });
  await expect(provider.verifyWebhook(body, new Headers())).rejects.toBeInstanceOf(WebhookSignatureError);
  provider.inbound('e1', { html: null, text: 'Текст', headers: [] }, []);
  expect(await provider.fetchInbound('e1')).toEqual({ html: null, text: 'Текст', headers: [] });
  await provider.send({ to: 'a@example.uz', subject: 's', html: 'h', text: 't' }, 'k1');
  expect(provider.sent).toEqual([{ message: { to: 'a@example.uz', subject: 's', html: 'h', text: 't' }, idempotencyKey: 'k1' }]);
});

test('чтение вложения прерывается по пределу времени: тело, которое не кончается, не держит разбор письма (M4, мелкое 13)', async () => {
  // Заголовки пришли сразу, тело отдаёт один кусок и замолкает.
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
      },
    });
    return new Response(body, { status: 200 });
  });
  const started = Date.now();
  await expect(make(fetch).download('https://cdn.example.test/slow', 1000)).rejects.toThrow(MailError);
  expect(Date.now() - started).toBeLessThan(2000);
});

test('обрыв связи посреди тела вложения: ошибка, а не обрезанный файл (итоговая проверка M4b, I4)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(4));
        } else controller.error(new Error('ECONNRESET'));
      },
    });
    return new Response(body, { status: 200 });
  });
  await expect(make(fetch).download('https://cdn.example.test/reset', 1000)).rejects.toThrow(MailError);
});

// Скачивание вложения письма (аудит 23.11.2026, находка S15): ссылку присылает почтовый сервис, но сервер портала
// идёт только на доверенные узлы и за переадресацией на чужой узел не следует.

test('вложение скачивается только с доверенного узла: чужой узел отклоняется без запроса', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new Uint8Array(4)));
  const provider = make(fetch, ['resend.com']);
  expect((await provider.download('https://inbound-cdn.resend.com/a?signature=s', 10)).byteLength).toBe(4);
  expect((await provider.download('https://resend.com/a', 10)).byteLength).toBe(4);
  for (const url of [
    'https://evil.example/a',
    'https://resend.com.evil.example/a',
    'https://notresend.com/a',
    'https://169.254.169.254/latest/meta-data',
    'https://user:pass@inbound-cdn.resend.com/a',
  ])
    await expect(provider.download(url, 10), url).rejects.toThrow('узел');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
});

test('переадресация вложения: на доверенный узел идём, на чужой нет, длинная цепочка обрывается', async () => {
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
  const inside = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(redirect('https://files.resend.com/b'))
    .mockResolvedValueOnce(new Response(new Uint8Array(3)));
  expect((await make(inside, ['resend.com']).download('https://inbound-cdn.resend.com/a', 10)).byteLength).toBe(3);
  expect(inside.mock.calls.map((call) => String(call[0]))).toEqual(['https://inbound-cdn.resend.com/a', 'https://files.resend.com/b']);

  const outside = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(redirect('https://169.254.169.254/latest/meta-data'));
  await expect(make(outside, ['resend.com']).download('https://inbound-cdn.resend.com/a', 10)).rejects.toThrow('узел');
  expect(outside).toHaveBeenCalledTimes(1);

  const downgrade = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(redirect('http://inbound-cdn.resend.com/b'));
  await expect(make(downgrade, ['resend.com']).download('https://inbound-cdn.resend.com/a', 10)).rejects.toThrow();
  expect(downgrade).toHaveBeenCalledTimes(1);

  const loop = vi.fn<typeof globalThis.fetch>(async () => redirect('https://inbound-cdn.resend.com/again'));
  await expect(make(loop, ['resend.com']).download('https://inbound-cdn.resend.com/a', 10)).rejects.toThrow();
  expect(loop.mock.calls.length).toBeLessThanOrEqual(4);
});

test('без настройки доверенным считается только узел почтового сервиса', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new Uint8Array(1)));
  const provider = createResendProvider({ apiKey: 're_key', from: 'Hub <hub@mail.example.test>', fetch, timeoutMs: 50, pausesMs: [0] });
  expect((await provider.download('https://inbound-cdn.resend.com/a', 10)).byteLength).toBe(1);
  await expect(provider.download('https://cdn.example.test/a', 10)).rejects.toThrow('узел');
});
