import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MOCK_SERVERS, startMockServer } from '../../scripts/mock-oidc.mjs';

// Ложный выпуск токена контекста (план M6, решение 17): обе схемы подписи. Порты свои, чтобы не мешать
// ложным серверам, которые держат браузерные тесты и разработка.

const SECRET = 'mock-context-secret-0123456789abcdef-0123';
const servers: { close(): Promise<void> }[] = [];
let jwksUrl: string;
let cloud: string;
let dedicated: string;

beforeAll(async () => {
  const a = await startMockServer('mock', { ...MOCK_SERVERS.mock, port: 4290 });
  const b = await startMockServer('mock-dedicated', { ...MOCK_SERVERS['mock-dedicated'], port: 4291, context: { mode: 'secret', secret: SECRET } });
  servers.push(a, b);
  cloud = a.url;
  dedicated = b.url;
  jwksUrl = `${a.url}/context-jwks.json`;
});
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const issue = async (base: string, query: string) => {
  const res = await fetch(`${base}/context-token?${query}`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as { token?: string } };
};

test('mock выпускает токен ES256 с ключом из /context-jwks.json и полями раздела 11.4', async () => {
  const { status, body } = await issue(cloud, 'persona=dilnoza&platform=android');
  expect(status).toBe(200);
  const jwks = await (await fetch(jwksUrl)).json();
  const { payload, protectedHeader } = await jwtVerify(body.token as string, createLocalJWKSet(jwks), {
    issuer: cloud,
    audience: 'smartup-hub',
    algorithms: ['ES256'],
  });
  expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'mock-context-1' });
  expect(payload).toMatchObject({ sub: '1002', name: 'Дильноза', company_id: '501', company_name: 'ACME Trade', role: 'director', platform: 'android' });
  expect(typeof payload.jti).toBe('string');
  expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(300);
  // Каждый токен одноразовый: новый jti.
  const again = await issue(cloud, 'persona=dilnoza');
  expect(decodeProtectedHeader(again.body.token as string).alg).toBe('ES256');
  expect(again.body.token).not.toBe(body.token);
});

test('mock-dedicated подписывает HS256 общим секретом, без секрета и с неизвестной персоной отказывает', async () => {
  const { status, body } = await issue(dedicated, 'persona=alisher');
  expect(status).toBe(200);
  const { payload } = await jwtVerify(body.token as string, new TextEncoder().encode(SECRET), { issuer: dedicated, audience: 'smartup-hub', algorithms: ['HS256'] });
  expect(payload).toMatchObject({ sub: '1001', company_name: 'Initech', platform: 'web' });
  expect((await issue(dedicated, 'persona=nobody')).status).toBe(400);
  expect((await issue(cloud, 'persona=alisher&platform=desktop')).status).toBe(400);
  // У mock-dedicated нет открытых ключей: режим secret.
  expect((await fetch(`${dedicated}/context-jwks.json`)).status).not.toBe(200);
});
