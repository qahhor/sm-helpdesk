import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { beforeAll, expect, test } from 'vitest';
import { ContextRejected, unverifiedIssuer, verifyContextToken } from '@/modules/hdu/core/context-token';
import type { ContextServer } from '@/modules/hdu/core/servers';
import { staticContextKeySource } from '@/modules/hdu/testing';

// Проверка токена контекста без базы (план M6, решение 4): подмена алгоритма, срок, получатель, издатель, поля.
// Источник ключей: заглушка из src/modules/hdu/testing.ts.

const ISS = 'https://id.cloud.example';
const SECRET = 'x'.repeat(43);
const jwksServer: ContextServer = { serverId: 's1', code: 'cloud', contextIssuer: ISS, mode: 'jwks', algorithms: ['ES256', 'EdDSA', 'RS256'], jwksUrl: 'https://k.example', secret: null };
const secretServer: ContextServer = { ...jwksServer, mode: 'secret', algorithms: ['HS256'], jwksUrl: null, secret: SECRET };

let key: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: JWK;
let keys: ReturnType<typeof staticContextKeySource>;

beforeAll(async () => {
  key = await generateKeyPair('ES256', { extractable: true });
  jwk = { ...(await exportJWK(key.publicKey)), kid: 'k1', alg: 'ES256' };
  keys = staticContextKeySource({ jwks: { keys: [jwk] }, secret: SECRET });
});

const now = Math.floor(Date.now() / 1000);
const base = { company_id: 501, company_name: 'ACME', name: 'Алишер', platform: 'ios', app_version: '5.1', email: 'a@acme.test', role: 'director' };

function sign(opts: { alg?: string; key?: Parameters<SignJWT['sign']>[0]; iss?: string; aud?: string; iat?: number; exp?: number; claims?: object } = {}) {
  return new SignJWT({ ...base, ...opts.claims })
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? 'smartup-hub')
    .setSubject('1001')
    .setJti('j1')
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 60)
    .sign(opts.key ?? key.privateKey);
}

const reason = (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: unknown) => (error instanceof ContextRejected ? error.reason : String(error)));

test('верный токен даёт сведения в виде сведений OAuth', async () => {
  const claims = await verifyContextToken(await sign(), jwksServer, keys);
  expect(claims).toEqual({
    sub: '1001',
    jti: 'j1',
    exp: now + 60,
    platform: 'ios',
    appVersion: '5.1',
    profile: { id: '1001', name: 'Алишер', companyId: '501', companyName: 'ACME', role: 'director', contactEmail: 'a@acme.test' },
  });
  expect(unverifiedIssuer(await sign())).toBe(ISS);
});

test('режим задаёт алгоритм: HS256 открытым ключом у сервера jwks и чужой алгоритм у сервера secret отклоняются', async () => {
  const pub = new TextEncoder().encode(JSON.stringify(jwk));
  expect(await reason(verifyContextToken(await sign({ alg: 'HS256', key: pub }), jwksServer, keys))).toBe('algorithm');
  expect(await reason(verifyContextToken(await sign(), secretServer, keys))).toBe('algorithm');
  expect(await reason(verifyContextToken(await sign({ alg: 'HS256', key: new TextEncoder().encode(SECRET) }), secretServer, keys))).toBe('accepted');
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISS })).toString('base64url')}.`;
  expect(await reason(verifyContextToken(none, jwksServer, keys))).toBe('algorithm');
  expect(await reason(verifyContextToken('garbage', jwksServer, keys))).toBe('malformed');
});

test('подпись, издатель, получатель, срок и поля', async () => {
  const other = await generateKeyPair('ES256');
  expect(await reason(verifyContextToken(await sign({ key: other.privateKey }), jwksServer, keys))).toBe('signature');
  expect(await reason(verifyContextToken(await sign({ iss: 'https://other.example' }), jwksServer, keys))).toBe('claims');
  expect(await reason(verifyContextToken(await sign({ aud: 'hub-embed' }), jwksServer, keys))).toBe('claims');
  expect(await reason(verifyContextToken(await sign({ iat: now, exp: now + 301 }), jwksServer, keys))).toBe('lifetime');
  expect(await reason(verifyContextToken(await sign({ iat: now - 500, exp: now - 100 }), jwksServer, keys))).toBe('lifetime');
  expect(await reason(verifyContextToken(await sign({ iat: now + 90, exp: now + 120 }), jwksServer, keys))).toBe('lifetime');
  expect(await reason(verifyContextToken(await sign({ claims: { platform: 'desktop' } }), jwksServer, keys))).toBe('claims');
  expect(await reason(verifyContextToken(await sign({ claims: { company_id: ' ' } }), jwksServer, keys))).toBe('claims');
  // Необязательное поле с неверным значением отбрасывается, обязательные проходят.
  expect((await verifyContextToken(await sign({ claims: { inn: 42 } }), jwksServer, keys)).profile.inn).toBeUndefined();
});
