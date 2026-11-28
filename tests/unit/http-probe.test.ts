import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { assertStagingTarget, percentile, probe, resolveProbeUrl } from '../../scripts/ops/http-probe.mjs';

// Замер по HTTP (план M9, задача 10, решение 14): scripts/ops/http-probe.mjs без новых зависимостей, прогрев и
// 40 запросов, p50 и p95 против порога. Работает только с ключом --target staging и не с адресом production
// (HUB_PRODUCTION_URL или hub.smartup24.com). Куки сессии берутся из переменной окружения и в вывод не попадают.

let server: Server;
let base = '';
const seen: { path: string; cookie: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', cookie: req.headers.cookie });
    const delay = req.url?.startsWith('/slow') ? 30 : 1;
    setTimeout(() => res.end(req.url === '/missing' ? '' : 'ok'), delay).unref();
    if (req.url === '/missing') res.statusCode = 404;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('процентили: p50 и p95 по отсортированным значениям', () => {
  const values = Array.from({ length: 40 }, (_, i) => i + 1);
  expect(percentile(values, 50)).toBe(20);
  expect(percentile(values, 95)).toBe(38);
  expect(percentile([5], 95)).toBe(5);
});

test('замер считает p50 и p95 и сверяет с порогом; куки уходят заголовком', async () => {
  seen.length = 0;
  const results = await probe(
    [
      { path: '/fast', target: 500 },
      { path: '/slow', target: 10 },
    ],
    { base, cookie: 'hub.session_token=SECRET-COOKIE', warmup: 2, count: 40 },
  );
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ url: `${base}/fast`, target: 500, ok: true, status: 200 });
  expect(results[1]).toMatchObject({ url: `${base}/slow`, target: 10, ok: false });
  expect(results[1]!.p95).toBeGreaterThanOrEqual(results[1]!.p50);
  expect(results[1]!.p50).toBeGreaterThanOrEqual(25);
  // Прогрев 2 и 40 замеров на адрес.
  expect(seen.filter((s) => s.path === '/fast')).toHaveLength(42);
  expect(seen.every((s) => s.cookie === 'hub.session_token=SECRET-COOKIE')).toBe(true);
});

test('ответ не 2xx: строка не проходит, даже если быстрая', async () => {
  const [missing] = await probe([{ path: '/missing', target: 500 }], { base, warmup: 0, count: 3 });
  expect(missing).toMatchObject({ ok: false, status: 404 });
});

test('без --target staging и с адресом production: отказ', () => {
  expect(() => assertStagingTarget({ target: undefined, base: 'https://staging.example.org' }, {})).toThrow(/--target staging/);
  expect(() => assertStagingTarget({ target: 'production', base: 'https://staging.example.org' }, {})).toThrow(/--target staging/);
  expect(() => assertStagingTarget({ target: 'staging', base: 'https://hub.example.org/ru' }, { HUB_PRODUCTION_URL: 'https://hub.example.org' })).toThrow(/production/);
  expect(() => assertStagingTarget({ target: 'staging', base: 'https://HUB.smartup24.com' }, {})).toThrow(/production/);
  expect(() => assertStagingTarget({ target: 'staging', base: 'https://staging.example.org' }, { HUB_PRODUCTION_URL: 'https://hub.example.org' })).not.toThrow();
});

test('имя production с конечной точкой тоже отклоняется (независимая проверка M9, I2)', () => {
  expect(() => assertStagingTarget({ target: 'staging', base: 'https://hub.smartup24.com.' }, {})).toThrow(/production/);
  expect(() => assertStagingTarget({ target: 'staging', base: 'https://hub.example.org./ru' }, { HUB_PRODUCTION_URL: 'https://hub.example.org' })).toThrow(/production/);
  expect(() => assertStagingTarget({ target: 'staging', base: 'https://hub.example.org' }, { HUB_PRODUCTION_URL: 'https://hub.example.org.' })).toThrow(/production/);
});

test('путь только относительно --base: полный адрес, "//узел" и обратная косая черта отклоняются (I2)', () => {
  const at = 'https://staging.example.org';
  expect(resolveProbeUrl('/ru/tickets?x=1', at)).toBe('https://staging.example.org/ru/tickets?x=1');
  for (const path of ['https://hub.smartup24.com/ru/tickets', '//hub.smartup24.com/ru', '/\\hub.smartup24.com/ru', '\\\\evil.example/x', 'ru/tickets', 'http://staging.example.org/ru', ''])
    expect(() => resolveProbeUrl(path, at), path).toThrow(/путь/i);
});

test('замер с чужим путём не делает ни одного запроса и не отдаёт куки (I2)', async () => {
  seen.length = 0;
  await expect(probe([{ path: '/fast', target: 500 }, { path: `//127.0.0.1:1/steal`, target: 500 }], { base, cookie: 'hub.session_token=SECRET-COOKIE', warmup: 0, count: 1 })).rejects.toThrow(/путь/i);
  expect(seen).toHaveLength(0);
});

test('запуск: куки из переменной окружения в вывод не попадают; без --target код 2', async () => {
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ['scripts/ops/http-probe.mjs', ...args], { env: { ...process.env, HUB_PROBE_COOKIE: 'hub.session_token=SECRET-COOKIE', HUB_PRODUCTION_URL: 'https://hub.example.org' } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });
  const refused = await run(['--base', base]);
  expect(refused.code).toBe(2);
  const ok = await run(['--target', 'staging', '--base', base, '--paths', '/fast', '--count', '5', '--warmup', '1']);
  expect(ok.code, ok.out).toBe(0);
  expect(ok.out).toMatch(/\/fast .*p50 \d+ мс, p95 \d+ мс/);
  expect(ok.out).not.toContain('SECRET-COOKIE');
  // Полный адрес в --paths: код 2, запроса нет (I2).
  seen.length = 0;
  const foreign = await run(['--target', 'staging', '--base', base, '--paths', `/fast,${base}/x`, '--count', '1', '--warmup', '0']);
  expect(foreign.code, foreign.out).toBe(2);
  expect(seen).toHaveLength(0);
});
