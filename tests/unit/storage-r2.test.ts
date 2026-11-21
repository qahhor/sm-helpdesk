import { createHash, createHmac } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { createR2Storage } from '@/modules/hdc/storage/r2';

// Хранилище R2 (раздел 11.11, решение 0027): подписанные ссылки SigV4 и запросы к бакету.

const now = () => new Date('2026-11-21T10:00:00Z');
const make = (fetchImpl: typeof fetch = vi.fn()) =>
  createR2Storage({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'hub', accessKeyId: 'AKID', secretAccessKey: 'secret', fetch: fetchImpl, now });

test('ссылка на загрузку PUT на 300 секунд подписывает тип и размер', async () => {
  const { url, headers } = await make().presignUpload('quarantine/0192-a', 'image/png', 1234);
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe('https://acct.r2.cloudflarestorage.com/hub/quarantine/0192-a');
  expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
  expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  expect(u.searchParams.get('X-Amz-Credential')).toBe('AKID/20261121/auto/s3/aws4_request');
  expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
  expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  expect(headers).toEqual({ 'Content-Type': 'image/png' });
  // Та же ссылка в то же время: подпись детерминирована, другой размер даёт другую подпись.
  expect((await make().presignUpload('quarantine/0192-a', 'image/png', 1234)).url).toBe(url);
  expect((await make().presignUpload('quarantine/0192-a', 'image/png', 1235)).url).not.toBe(url);
});

test('подпись ссылки на загрузку совпадает с независимым расчётом SigV4 (эталон для R2)', async () => {
  const { url } = await make().presignUpload('quarantine/0192-a', 'image/png', 1234);
  const query = [
    'X-Amz-Algorithm=AWS4-HMAC-SHA256',
    'X-Amz-Credential=AKID%2F20261121%2Fauto%2Fs3%2Faws4_request',
    'X-Amz-Date=20261121T100000Z',
    'X-Amz-Expires=300',
    'X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost',
  ].join('&');
  const canonical = [
    'PUT',
    '/hub/quarantine/0192-a',
    query,
    'content-length:1234\ncontent-type:image/png\nhost:acct.r2.cloudflarestorage.com\n',
    'content-length;content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', '20261121T100000Z', '20261121/auto/s3/aws4_request', createHash('sha256').update(canonical).digest('hex')].join('\n');
  const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac('AWS4secret', '20261121'), 'auto'), 's3'), 'aws4_request');
  expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(createHmac('sha256', signingKey).update(toSign).digest('hex'));
});

test('ссылка на скачивание на 60 секунд с Content-Disposition: attachment и именем в UTF-8', async () => {
  const url = new URL(await make().presignDownload('files/org/0192-a', { filename: 'Отчёт "за" ноябрь.pdf', contentType: 'application/pdf', ttlSeconds: 60 }));
  expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  const rfc5987 = encodeURIComponent('Отчёт "за" ноябрь.pdf').replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  expect(url.searchParams.get('response-content-disposition')).toBe(`attachment; filename="_____ ____ ______.pdf"; filename*=UTF-8''${rfc5987}`);
  const inline = new URL(await make().presignDownload('files/org/0192-a', { filename: 'shot.png', contentType: 'image/png', ttlSeconds: 60, inline: true }));
  expect(inline.searchParams.get('response-content-disposition')).toMatch(/^inline; /);
});

test('ответ по ссылке на скачивание: тип файла от портала и запрет кеширования, а не то, что лежит в объекте (вторая проверка M2)', async () => {
  const url = new URL(await make().presignDownload('files/org/0192-a', { filename: 'shot.png', contentType: 'image/png', ttlSeconds: 60, inline: true }));
  expect(url.searchParams.get('response-content-type')).toBe('image/png');
  expect(url.searchParams.get('response-cache-control')).toBe('private, no-store');
  // Параметры ответа входят в подпись: ссылка с другим типом подписана иначе, поменять тип в ссылке нельзя.
  const other = new URL(await make().presignDownload('files/org/0192-a', { filename: 'shot.png', contentType: 'text/html', ttlSeconds: 60, inline: true }));
  expect(other.searchParams.get('X-Amz-Signature')).not.toBe(url.searchParams.get('X-Amz-Signature'));
});

test('перенос из карантина заменяет метаданные объекта: остаётся только тип файла от портала', async () => {
  // Браузер мог положить файл с лишними заголовками (Content-Encoding, Content-Disposition, x-amz-meta-*):
  // копия получает только то, что задал портал.
  let copy: Request | null = null;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === 'PUT') copy = req;
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  await make(fetchImpl).move('quarantine/x', 'files/o/x', { contentType: 'application/pdf', ifMatch: '"abc"' });
  const sent = copy as Request | null;
  expect(sent?.headers.get('x-amz-metadata-directive')).toBe('REPLACE');
  expect(sent?.headers.get('content-type')).toBe('application/pdf');
  expect(sent?.headers.get('x-amz-copy-source-if-match')).toBe('"abc"');
  // Директива подписана: без неё копия унаследовала бы метаданные загрузки.
  expect(sent?.headers.get('authorization')).toMatch(/SignedHeaders=[^,]*x-amz-metadata-directive/);
});

test('head, move, stream и remove обращаются к бакету подписанными запросами; перенос сверяет ETag прочитанного', async () => {
  const calls: { method: string; url: string; copy: string | null; ifMatch: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ method: req.method, url: req.url, copy: req.headers.get('x-amz-copy-source'), ifMatch: req.headers.get('x-amz-copy-source-if-match') });
    expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '42' } });
    if (req.method === 'GET') return new Response('data', { headers: { etag: '"abc123"' } });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const s = make(fetchImpl);
  expect(await s.head('quarantine/x')).toEqual({ size: 42 });
  const { body, etag } = await s.stream('files/o/x');
  expect(await new Response(body).text()).toBe('data');
  expect(etag).toBe('"abc123"');
  await s.move('quarantine/x', 'files/o/x', { contentType: 'text/plain', ifMatch: etag });
  await s.remove('files/o/x');
  expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname} ${c.copy ?? ''} ${c.ifMatch ?? ''}`.trim())).toEqual([
    'HEAD /hub/quarantine/x',
    'GET /hub/files/o/x',
    'PUT /hub/files/o/x /hub/quarantine/x "abc123"',
    'DELETE /hub/quarantine/x',
    'DELETE /hub/files/o/x',
  ]);
});

test('объект подменили после чтения: копирование отвечает 412, перенос бросает ошибку и источник не удаляется', async () => {
  const methods: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    methods.push(req.method);
    return new Response(null, { status: req.method === 'PUT' ? 412 : 200 });
  }) as unknown as typeof fetch;
  await expect(make(fetchImpl).move('quarantine/x', 'files/o/x', { contentType: 'text/plain', ifMatch: '"old"' })).rejects.toThrow(/412/);
  expect(methods).toEqual(['PUT']);
});

test('нет объекта: head пусто, ошибка бакета бросает исключение без ключа доступа', async () => {
  const missing = make(vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
  expect(await missing.head('quarantine/none')).toBeNull();
  const broken = make(vi.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch);
  await expect(broken.stream('files/x')).rejects.toThrow(/403/);
  await expect(broken.stream('files/x')).rejects.not.toThrow(/secret|AKID/);
});

test('без метки ETag чтение отказывает: перенос из карантина без проверки версии невозможен', async () => {
  const noEtag = make(vi.fn(async () => new Response('data')) as unknown as typeof fetch);
  await expect(noEtag.stream('quarantine/x')).rejects.toThrow(/ETag/);
  // Пустая метка тоже не отключает условие копирования.
  const headers: (string | null)[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(new Request(input, init).headers.get('x-amz-copy-source-if-match'));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  await make(fetchImpl).move('quarantine/x', 'files/o/x', { contentType: 'text/plain', ifMatch: '' });
  expect(headers[0]).toBe('');
});
