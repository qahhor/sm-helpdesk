import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { SystemActor } from '@/db/with-actor';
import { handleEmbedSession, requireEmbedActor } from '@/modules/hdu/api/embed';
import { resetContextKeysForTests } from '@/modules/hdu/core/context-keys';
import { addServer, updateWidgetSettings } from '@/modules/hdu/api/servers';
import { cleanupAuthRows } from '@/modules/hdu/api/maintenance';
import { setDnsResolverForTests } from '@/modules/hdu/url-safety';
import { staffCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { spyOutbound } from './helpers/outbound';
import { seedTwoOrgs } from './isolation/fixture';

// Обмен токена контекста на токен виджета (план M6, задача 2; ТЗ 11.4, FR-WG-04, FR-WG-05, T8, 14.5; решения 2, 4, 5,
// 14, 15 и 16). Проверки раздела "На что смотреть", пункты 2 и 3: подделка и повтор токена, путаница серверов.

const system: SystemActor = { type: 'system', job: 'test' };
const HUB = process.env.HUB_URL as string;
const CLOUD = 'https://id.cloud.smartup.example';
const DEDICATED = 'https://id.dedicated.smartup.example';
const JWKS_URL = `${CLOUD}/hub/context-jwks`;

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let cloudKey: Keys;
let otherKey: Keys;
let rsaKey: Keys;
let cloudJwk: JWK;
let jwks: { keys: JWK[] };
let fetched: string[];

beforeAll(async () => {
  setDnsResolverForTests(async () => ['203.0.113.10']);
  cloudKey = await generateKeyPair('ES256', { extractable: true });
  otherKey = await generateKeyPair('ES256', { extractable: true });
  rsaKey = await generateKeyPair('RS256', { extractable: true });
  cloudJwk = { ...(await exportJWK(cloudKey.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
});
afterAll(() => setDnsResolverForTests(null));

let spy: ReturnType<typeof spyOutbound>;
beforeEach(() => {
  resetContextKeysForTests();
  jwks = { keys: [cloudJwk] };
  fetched = [];
  // Ключи сервера Smartup отдаются через сетевой слой исходящих запросов (src/security/outbound.ts), сети в тестах нет.
  spy = spyOutbound().mockImplementation(async (url) => {
    fetched.push(String(url));
    if (String(url) === JWKS_URL) return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  });
});
afterEach(() => {
  spy.mockRestore();
  vi.useRealTimers();
});

async function setup() {
  const f = await seedTwoOrgs();
  const ctx = staffCtx(f.adminStaff);
  for (const [code, issuer] of [
    ['cloud', CLOUD],
    ['dedicated', DEDICATED],
  ] as const)
    await addServer(system, { code, name: code, baseUrl: `https://${code}.smartup.example`, issuer, clientId: 'hub', clientSecret: 'oauth-secret' });
  await updateWidgetSettings(ctx, { code: 'cloud', mode: 'jwks', jwksUrl: JWKS_URL, embedOrigins: [] });
  const { secret } = await updateWidgetSettings(ctx, { code: 'dedicated', mode: 'secret', embedOrigins: [] });
  return { f, ctx, secret: new TextEncoder().encode(secret as string) };
}

type TokenOptions = {
  key?: Parameters<SignJWT['sign']>[0];
  alg?: string;
  header?: Record<string, unknown>;
  iss?: string;
  aud?: string;
  sub?: string;
  jti?: string | null;
  iat?: number;
  exp?: number;
  claims?: Record<string, unknown>;
};

const now = () => Math.floor(Date.now() / 1000);

/** Токен контекста, как его выпускает сервер Smartup (ТЗ 11.4). По умолчанию: облако, ES256, ключ k1. */
function contextToken(opts: TokenOptions = {}): Promise<string> {
  const iat = opts.iat ?? now();
  const payload = { company_id: '501', company_name: 'ACME Trade', name: 'Алишер', platform: 'web', app_version: '5.12.0', ...opts.claims };
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: 'k1', ...opts.header } as never)
    .setIssuer(opts.iss ?? CLOUD)
    .setAudience(opts.aud ?? 'smartup-hub')
    .setSubject(opts.sub ?? '1001')
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + 120);
  if (opts.jti !== null) jwt.setJti(opts.jti ?? randomUUID());
  return jwt.sign(opts.key ?? cloudKey.privateKey);
}

/** Неподписанный токен alg none: его собирают руками, jose такой не выпускает. */
function unsecuredToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.`;
}

let ipSerial = 0;

/** Запрос страницы виджета к порталу: тот же адрес, JSON. Каждый запрос со своего адреса, если адрес не задан. */
function exchange(contextTokenValue: unknown, opts: { ip?: string; authorization?: string; origin?: string } = {}) {
  ipSerial += 1;
  return handleEmbedSession(
    new Request(`${HUB}/api/embed/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: opts.origin ?? HUB,
        'x-forwarded-for': opts.ip ?? `198.51.100.${ipSerial % 250}`,
        ...(opts.authorization && { authorization: opts.authorization }),
      },
      body: JSON.stringify({ contextToken: contextTokenValue }),
    }),
  );
}

async function expectRejected(response: Response) {
  expect(response.status).toBe(401);
  // Одна причина на любой отказ: что именно не так, знает только журнал работы.
  expect(await response.json()).toMatchObject({ code: 'invalid_context' });
}

const withBearer = (token: string) => new Request(`${HUB}/api/embed/tickets`, { headers: { authorization: `Bearer ${token}` } });

test('токен контекста облака меняется на токен виджета: та же учётная запись и организация, что при входе OAuth, без кук', async () => {
  await setup();
  const response = await exchange(await contextToken());
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as { embedToken: string; expiresIn: number };
  expect(body.expiresIn).toBe(900);

  const account = (await pools.root.query(`select "userId" from auth.account where "providerId" = 'cloud' and "accountId" = '1001'`)).rows;
  expect(account).toHaveLength(1);
  const org = (await pools.root.query(
    `select o.org_id from hdu_organizations o join hdu_servers s on s.server_id = o.server_id where s.code = 'cloud' and o.external_company_id = '501'`,
  )).rows[0];
  const embed = await requireEmbedActor(withBearer(body.embedToken));
  expect(embed.actor).toEqual({ type: 'client', userId: account[0].userId, orgId: org.org_id, orgRole: 'client_user', ip: null });
  expect(embed).toMatchObject({ serverCode: 'cloud', platform: 'web' });

  // Новая сессия виджета пишется в журнал аудита, как вход клиента (решение 15).
  const audit = (await pools.root.query(`select object_id, org_id, diff from hdc_audit_log where action = 'client.embed_session'`)).rows;
  expect(audit).toEqual([{ object_id: account[0].userId, org_id: org.org_id, diff: { server: 'cloud', platform: 'web' } }]);

  // Продление с действующим токеном виджета того же человека в журнал аудита не пишется.
  expect((await exchange(await contextToken(), { authorization: `Bearer ${body.embedToken}` })).status).toBe(200);
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where action = 'client.embed_session'`)).rows[0].n).toBe(1);
});

test('чужая подпись, alg none, подмена HS256 открытым ключом и чужой алгоритм отклоняются', async () => {
  const { secret } = await setup();
  await expectRejected(await exchange(await contextToken({ key: otherKey.privateKey })));
  await expectRejected(await exchange(unsecuredToken({ iss: CLOUD, aud: 'smartup-hub', sub: '1001', jti: randomUUID(), iat: now(), exp: now() + 60 })));
  // Открытый ключ сервера jwks как общий секрет HS256 (путаница алгоритмов).
  for (const asSecret of [JSON.stringify(cloudJwk), cloudJwk.x as string])
    await expectRejected(await exchange(await contextToken({ alg: 'HS256', key: new TextEncoder().encode(asSecret) })));
  // RS256 разрешён режиму jwks, но такого ключа у сервера нет.
  await expectRejected(await exchange(await contextToken({ alg: 'RS256', key: rsaKey.privateKey })));
  // Сервер с общим секретом принимает только HS256: подпись ES256 даже верным ключом облака не проходит.
  await expectRejected(await exchange(await contextToken({ iss: DEDICATED, key: cloudKey.privateKey })));
  await expectRejected(await exchange(await contextToken({ iss: DEDICATED, alg: 'HS512', key: secret })));
  await expectRejected(await exchange(await contextToken({ iss: DEDICATED, alg: 'HS256', key: new TextEncoder().encode('x'.repeat(43)) })));
  expect((await exchange(await contextToken({ iss: DEDICATED, alg: 'HS256', key: secret }))).status).toBe(200);
  // Ни один отказ не создал учётной записи облака.
  expect((await pools.root.query(`select count(*)::int as n from auth.account where "providerId" = 'cloud'`)).rows[0].n).toBe(0);
});

test('адрес ключей из самого токена не используется, ключи берутся только по адресу из реестра', async () => {
  await setup();
  const attacker = { ...(await exportJWK(otherKey.publicKey)), kid: 'evil', alg: 'ES256' };
  for (const header of [
    { kid: 'evil', jku: 'https://attacker.example/jwks' },
    { kid: 'evil', x5u: 'https://attacker.example/cert' },
    { kid: 'evil', jwk: attacker },
  ])
    await expectRejected(await exchange(await contextToken({ key: otherKey.privateKey, header })));
  expect(fetched.filter((url) => !url.startsWith(JWKS_URL))).toEqual([]);
});

test('ключи кешируются, неизвестный kid вызывает повторную загрузку не чаще раза в минуту', async () => {
  await setup();
  expect((await exchange(await contextToken())).status).toBe(200);
  expect((await exchange(await contextToken())).status).toBe(200);
  expect(fetched).toEqual([JWKS_URL]);
  // Неизвестный kid: одна повторная загрузка, затем отказ.
  await expectRejected(await exchange(await contextToken({ header: { kid: 'k-missing' }, key: otherKey.privateKey })));
  expect(fetched).toHaveLength(2);
  await expectRejected(await exchange(await contextToken({ header: { kid: 'k-missing-2' }, key: otherKey.privateKey })));
  expect(fetched).toHaveLength(2);
  // Сервер добавил новый ключ: через минуту неизвестный kid загружает ключи снова, и токен принимается.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
  jwks = { keys: [cloudJwk, { ...(await exportJWK(otherKey.publicKey)), kid: 'k2', alg: 'ES256' }] };
  expect((await exchange(await contextToken({ header: { kid: 'k2' }, key: otherKey.privateKey }))).status).toBe(200);
  expect(fetched).toHaveLength(3);
});

test('срок: просроченный, слишком долгий и будущий токен отклоняются, допуск часов 60 секунд', async () => {
  await setup();
  await expectRejected(await exchange(await contextToken({ iat: now() - 400, exp: now() - 61 })));
  await expectRejected(await exchange(await contextToken({ iat: now(), exp: now() + 301 })));
  await expectRejected(await exchange(await contextToken({ iat: now() + 120, exp: now() + 200 })));
  // Старый iat при живом exp: токен старше пяти минут с допуском.
  await expectRejected(await exchange(await contextToken({ iat: now() - 400, exp: now() - 100 + 300 })));
  expect((await exchange(await contextToken({ iat: now() + 30, exp: now() + 120 }))).status).toBe(200);
  expect((await exchange(await contextToken({ iat: now() - 250, exp: now() - 30 }))).status).toBe(200);
});

test('другой получатель, неизвестный и отключённый издатель, неполные сведения отклоняются', async () => {
  await setup();
  for (const aud of ['hub-embed', 'smartup-hub-x', ''])
    await expectRejected(await exchange(await contextToken({ aud })));
  await expectRejected(await exchange(await contextToken({ iss: 'https://unknown.smartup.example' })));
  for (const claims of [
    { platform: 'desktop' },
    { platform: undefined },
    { company_id: '' },
    { company_id: undefined },
    { company_name: undefined },
    { name: undefined },
    { app_version: undefined },
  ])
    await expectRejected(await exchange(await contextToken({ claims })));
  await expectRejected(await exchange(await contextToken({ sub: '' })));
  await expectRejected(await exchange(await contextToken({ jti: null })));
  await pools.root.query(`update hdu_servers set state = 'passive' where code = 'cloud'`);
  await expectRejected(await exchange(await contextToken()));
  // Неверный запрос: не JSON, чужая страница, пустое тело.
  expect((await exchange(42)).status).toBe(400);
  expect((await exchange('x'.repeat(9000))).status).toBe(400);
  expect((await exchange(await contextToken(), { origin: 'https://cloud.smartup.example' })).status).toBe(403);
});

test('повторный токен отклоняется; тот же jti другого сервера это другой токен', async () => {
  const { secret } = await setup();
  const token = await contextToken({ jti: 'same-jti' });
  expect((await exchange(token)).status).toBe(200);
  await expectRejected(await exchange(token));
  await expectRejected(await exchange(await contextToken({ jti: 'same-jti' })));
  expect((await exchange(await contextToken({ iss: DEDICATED, alg: 'HS256', key: secret, jti: 'same-jti' }))).status).toBe(200);
  // Строка повтора живёт до срока токена с допуском 60 секунд, потом её удаляет ночная очистка.
  const row = (await pools.root.query(`select extract(epoch from expires_on)::int as e from hdu_context_token_uses where jti = 'same-jti' limit 1`)).rows[0];
  expect(Math.abs(row.e - (now() + 120 + 60))).toBeLessThanOrEqual(5);
  await pools.root.query(`update hdu_context_token_uses set expires_on = now() - interval '1 second'`);
  await cleanupAuthRows(system);
  expect((await pools.root.query(`select count(*)::int as n from hdu_context_token_uses`)).rows[0].n).toBe(0);
});

test('путаница серверов: подпись одного сервера с издателем другого не проходит, одинаковый sub это два человека', async () => {
  const { f, secret } = await setup();
  // Ключ облака, издатель выделенного сервера: проверяется ключом выделенного сервера и не проходит.
  await expectRejected(await exchange(await contextToken({ iss: DEDICATED })));
  await expectRejected(await exchange(await contextToken({ iss: CLOUD, alg: 'HS256', key: secret })));

  const cloud = (await (await exchange(await contextToken({ sub: '1001' }))).json()) as { embedToken: string };
  const dedicated = (await (await exchange(await contextToken({ iss: DEDICATED, alg: 'HS256', key: secret, sub: '1001' }))).json()) as { embedToken: string };
  const a = await requireEmbedActor(withBearer(cloud.embedToken));
  const b = await requireEmbedActor(withBearer(dedicated.embedToken));
  expect(a.actor.userId).not.toBe(b.actor.userId);
  expect(a.actor.orgId).not.toBe(b.actor.orgId);

  // Токен выделенного сервера с company_id организации А сервера набора: организация выделенного сервера, не А.
  const externalA = (await pools.root.query(`select external_company_id from hdu_organizations where org_id = $1`, [f.orgA.orgId])).rows[0].external_company_id;
  const response = await exchange(await contextToken({ iss: DEDICATED, alg: 'HS256', key: secret, sub: '7001', claims: { company_id: externalA } }));
  const own = await requireEmbedActor(withBearer(((await response.json()) as { embedToken: string }).embedToken));
  expect(own.actor.orgId).not.toBe(f.orgA.orgId);
  const server = (await pools.root.query(`select s.code from hdu_organizations o join hdu_servers s using (server_id) where o.org_id = $1`, [own.actor.orgId])).rows[0];
  expect(server.code).toBe('dedicated');
});

test('отключённый участник, отключённая организация и сотрудник токена виджета не получают; отключение действует сразу', async () => {
  await setup();
  const { embedToken } = (await (await exchange(await contextToken())).json()) as { embedToken: string };
  const { actor } = await requireEmbedActor(withBearer(embedToken));

  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [actor.userId]);
  await expect(requireEmbedActor(withBearer(embedToken))).rejects.toMatchObject({ code: 'forbidden' });
  expect((await exchange(await contextToken())).status).toBe(403);
  await pools.root.query(`update hdu_memberships set state = 'active' where user_id = $1`, [actor.userId]);
  expect((await requireEmbedActor(withBearer(embedToken))).actor.userId).toBe(actor.userId);

  await pools.root.query(`update hdu_organizations set state = 'passive' where org_id = $1`, [actor.orgId]);
  await expect(requireEmbedActor(withBearer(embedToken))).rejects.toMatchObject({ code: 'forbidden' });
  expect((await exchange(await contextToken())).status).toBe(403);
  await pools.root.query(`update hdu_organizations set state = 'active' where org_id = $1`, [actor.orgId]);

  await pools.root.query(`update hdu_servers set state = 'passive' where code = 'cloud'`);
  await expect(requireEmbedActor(withBearer(embedToken))).rejects.toMatchObject({ code: 'forbidden' });
  await pools.root.query(`update hdu_servers set state = 'active' where code = 'cloud'`);

  // Сотрудник с учётной записью Smartup актора клиента не получает.
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, 'care')`, [actor.userId]);
  await expect(requireEmbedActor(withBearer(embedToken))).rejects.toMatchObject({ code: 'forbidden' });
  expect((await exchange(await contextToken())).status).toBe(403);
});

test('токен виджета: чужой секрет, alg none, другой получатель, просроченный и испорченный отклоняются', async () => {
  await setup();
  const { embedToken } = (await (await exchange(await contextToken())).json()) as { embedToken: string };
  const { actor } = await requireEmbedActor(withBearer(embedToken));
  const sign = (claims: Record<string, unknown>, opts: { key?: string; aud?: string; exp?: number; iss?: string } = {}) =>
    new SignJWT({ org: actor.orgId, srv: claims.srv, plt: 'web', ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(opts.iss ?? HUB)
      .setAudience(opts.aud ?? 'hub-embed')
      .setSubject(actor.userId)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? now() + 600)
      .sign(new TextEncoder().encode(opts.key ?? (process.env.EMBED_TOKEN_SECRET as string)));
  const server = (await pools.root.query(`select server_id from hdu_servers where code = 'cloud'`)).rows[0].server_id as string;
  // Своим секретом подписанный токен проходит: проверка ниже меняет по одному признаку.
  expect((await requireEmbedActor(withBearer(await sign({ srv: server })))).actor.orgId).toBe(actor.orgId);
  for (const token of [
    await sign({ srv: server }, { key: 'другой-секрет-другой-секрет-другой-секрет' }),
    await sign({ srv: server }, { aud: 'smartup-hub' }),
    await sign({ srv: server }, { iss: CLOUD }),
    await sign({ srv: server }, { exp: now() - 120 }),
    unsecuredToken({ sub: actor.userId, org: actor.orgId, srv: server, plt: 'web', aud: 'hub-embed', iss: HUB, exp: now() + 600 }),
    `${embedToken.slice(0, -2)}xx`,
    'not-a-token',
  ])
    await expect(requireEmbedActor(withBearer(token)), token.slice(0, 40)).rejects.toMatchObject({ code: 'unauthenticated' });
  // Организация, в которой человек не состоит, даже при верной подписи.
  await expect(requireEmbedActor(withBearer(await sign({ srv: server, org: (await seedOrgB()) as string })))).rejects.toMatchObject({ code: 'forbidden' });
  await expect(requireEmbedActor(new Request(`${HUB}/api/embed/tickets`))).rejects.toMatchObject({ code: 'unauthenticated' });
  await expect(requireEmbedActor(new Request(`${HUB}/api/embed/tickets`, { headers: { authorization: `Basic ${embedToken}` } }))).rejects.toMatchObject({
    code: 'unauthenticated',
  });
});

/** Организация того же сервера облака, где пользователь не состоит. */
async function seedOrgB(): Promise<string> {
  const r = await pools.root.query(
    `insert into hdu_organizations (server_id, external_company_id, name) select server_id, '777', 'Globex' from hdu_servers where code = 'cloud' returning org_id`,
  );
  return r.rows[0].org_id as string;
}

test('неудачные обмены: 20 за 10 минут с одного адреса, затем 429', async () => {
  await setup();
  for (let i = 0; i < 20; i += 1) await expectRejected(await exchange('bad.token.value', { ip: '203.0.113.77' }));
  const blocked = await exchange(await contextToken(), { ip: '203.0.113.77' });
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  // Другой адрес не заблокирован.
  expect((await exchange(await contextToken(), { ip: '203.0.113.78' })).status).toBe(200);
});

test('обмен: 30 в минуту на пользователя', async () => {
  await setup();
  for (let i = 0; i < 30; i += 1) expect((await exchange(await contextToken())).status, `попытка ${i + 1}`).toBe(200);
  expect((await exchange(await contextToken())).status).toBe(429);
  expect((await exchange(await contextToken({ sub: '2002' }))).status).toBe(200);
});

test('повтор и срок не закрывают адрес: неудачей адреса считаются только подделки (проверка M6, M1)', async () => {
  await setup();
  const ip = '203.0.113.90';
  const token = await contextToken();
  expect((await exchange(token, { ip })).status).toBe(200);
  for (let i = 0; i < 12; i += 1) await expectRejected(await exchange(token, { ip }));
  for (let i = 0; i < 10; i += 1) await expectRejected(await exchange(await contextToken({ iat: now() - 400, exp: now() - 100 }), { ip }));
  // 22 отказа без вины адреса: адрес не закрыт.
  expect((await exchange(await contextToken(), { ip })).status).toBe(200);
  // Подделки считаются: неверная подпись, неизвестный издатель, мусор, чужой алгоритм.
  for (let i = 0; i < 5; i += 1) {
    await expectRejected(await exchange(await contextToken({ key: otherKey.privateKey }), { ip }));
    await expectRejected(await exchange(await contextToken({ iss: 'https://unknown.smartup.example' }), { ip }));
    await expectRejected(await exchange('bad.token.value', { ip }));
    await expectRejected(await exchange(await contextToken({ alg: 'RS256', key: rsaKey.privateKey }), { ip }));
  }
  expect((await exchange(await contextToken(), { ip })).status).toBe(429);
});

test('ключи сервера недоступны: 503, адрес не закрывается, повторная загрузка не чаще раза в 30 секунд (проверка M6, M1)', async () => {
  await setup();
  const ip = '203.0.113.91';
  let down = true;
  spy.mockImplementation(async (url) => {
    fetched.push(String(url));
    if (down) return new Response('fail', { status: 502 });
    return new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } });
  });
  for (let i = 0; i < 22; i += 1) {
    const response = await exchange(await contextToken(), { ip });
    expect(response.status, `попытка ${i + 1}`).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'context_keys_unavailable' });
  }
  // Сбой загрузки запоминается на 30 секунд: 22 обмена, одна загрузка.
  expect(fetched).toEqual([JWKS_URL]);
  down = false;
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 29_000 });
  expect((await exchange(await contextToken(), { ip })).status).toBe(503);
  expect(fetched).toHaveLength(1);
  vi.setSystemTime(Date.now() + 2_000);
  expect((await exchange(await contextToken(), { ip })).status).toBe(200);
  expect(fetched).toHaveLength(2);
});
