import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { createBotCheck } from '@/security/bot-check';
import { BotCheckField } from '@/ui/components/BotCheckField';

// Проверка "не робот" (Cloudflare Turnstile) за интерфейсом: без ключей выключена (решение 0018).

const answer = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
const make = (fetch: typeof globalThis.fetch) => createBotCheck({ secret: 'sec', hostname: 'hub.smartup24.com', fetch, timeoutMs: 50 });

test('ответ с success и своим узлом проходит, в запросе секрет, токен и адрес посетителя', async () => {
  const fetch = answer({ success: true, hostname: 'hub.smartup24.com' });
  expect(await make(fetch).verify('tok', '203.0.113.7')).toBe('passed');
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(init.method).toBe('POST');
  const body = new URLSearchParams(String(init.body));
  expect(body.get('secret')).toBe('sec');
  expect(body.get('response')).toBe('tok');
  expect(body.get('remoteip')).toBe('203.0.113.7');
});

test('без адреса посетителя поле remoteip не отправляется', async () => {
  const fetch = answer({ success: true, hostname: 'hub.smartup24.com' });
  await make(fetch).verify('tok', null);
  expect(new URLSearchParams(String((fetch.mock.calls[0] as [string, RequestInit])[1].body)).has('remoteip')).toBe(false);
});

test('отказ сервиса и токен с чужого сайта не проходят', async () => {
  expect(await make(answer({ success: false, 'error-codes': ['invalid-input-response'] })).verify('tok', null)).toBe('failed');
  expect(await make(answer({ success: false, 'error-codes': ['timeout-or-duplicate'] })).verify('tok', null)).toBe('failed');
  expect(await make(answer({ success: true, hostname: 'evil.example' })).verify('tok', null)).toBe('failed');
  expect(await make(answer({ success: true })).verify('tok', null)).toBe('failed');
});

test('пустой, слишком длинный и нестроковый токен отклоняются без запроса', async () => {
  const fetch = answer({ success: true, hostname: 'hub.smartup24.com' });
  for (const token of [null, undefined, '', 42, ['x'], 'x'.repeat(2049)]) expect(await make(fetch).verify(token, null)).toBe('failed');
  expect(fetch).not.toHaveBeenCalled();
});

test('сбой сервиса проверки не закрывает вход', async () => {
  expect(
    await make(
      vi.fn(async () => {
        throw new Error('сеть');
      }),
    ).verify('tok', null),
  ).toBe('unavailable');
  expect(await make(answer({}, 503)).verify('tok', null)).toBe('unavailable');
  expect(await make(vi.fn(async () => new Response('<html>', { status: 200 }))).verify('tok', null)).toBe('unavailable');
  // Истекло время: сервис молчит.
  expect(await make(vi.fn(() => new Promise<Response>(() => {}))).verify('tok', null)).toBe('unavailable');
});

test('без ключа проверка выключена', async () => {
  const fetch = answer({});
  const check = createBotCheck({ hostname: 'hub.smartup24.com', fetch });
  expect(check.enabled).toBe(false);
  expect(await check.verify(null, null)).toBe('passed');
  expect(fetch).not.toHaveBeenCalled();
});

test('поле проверки выводится только при заданном ключе и несёт одноразовый код страницы', () => {
  expect(renderToStaticMarkup(BotCheckField({ siteKey: undefined, nonce: 'n1', locale: 'ru' }))).toBe('');
  const html = renderToStaticMarkup(BotCheckField({ siteKey: 'site-key', nonce: 'n1', locale: 'uz' }));
  expect(html).toContain('data-sitekey="site-key"');
  expect(html).toContain('data-language="uz"');
  expect(html).toContain('nonce="n1"');
  expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
});
