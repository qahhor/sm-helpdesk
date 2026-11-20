import { betterAuth } from 'better-auth';
import { hashPassword } from 'better-auth/crypto';
import { getAuthPool } from '@/db/auth-client';
import { type AuthDeps, buildAuthOptions } from '@/modules/hdu/auth/options';
import { findStaff } from '@/modules/hdu/core/staff';
import { listSsoServers } from '@/modules/hdu/core/servers';
import type { StaffRole } from '@/modules/hdu/pref';
import { getSecretBox } from '@/security/secret-box';
import { totp } from '../../helpers/totp';
import { pools } from './db';

// Помощники тестов входа. Экземпляр библиотеки собирается из тех же настроек, что и в приложении,
// но функции, которые появляются в следующих задачах, здесь заменены: письмо запоминается,
// вход через сервер по умолчанию отклоняется.

export type MagicLinkMail = { email: string; token: string; url: string; metadata?: unknown };

export async function buildTestAuth(overrides: Partial<AuthDeps> = {}) {
  const sent: MagicLinkMail[] = [];
  const deps: AuthDeps = {
    pool: getAuthPool(),
    secret: process.env.BETTER_AUTH_SECRET as string,
    baseUrl: process.env.HUB_URL as string,
    servers: await listSsoServers(),
    staff: findStaff,
    sendMagicLink: async (data) => {
      sent.push(data);
    },
    resolveUser: async () => {
      throw new Error('Вход через сервер в этом тесте не подключён');
    },
    provisionUser: async () => {},
    ...overrides,
  };
  return { auth: betterAuth(buildAuthOptions(deps)), deps, sent, lastToken: () => sent.at(-1)?.token as string };
}

export type TestAuth = Awaited<ReturnType<typeof buildTestAuth>>['auth'];

/** Куки из ответа, как их запомнил бы браузер. */
export function cookieOf(headers: Headers, previous = ''): string {
  const jar = new Map(
    previous
      .split('; ')
      .filter(Boolean)
      .map((pair) => [pair.split('=')[0] as string, pair]),
  );
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';')[0] as string;
    const name = pair.split('=')[0] as string;
    if (/max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()].join('; ');
}

const withCookie = (cookie: string) => new Headers(cookie ? { cookie } : {});

let serial = 0;
const next = () => `${Date.now()}-${++serial}`;

export type StaffFixture = { userId: string; email: string; password: string; totpSecret: string };

/** Сотрудник строками в базе: подтверждённый адрес, пароль, строка в hdu_staff. Второй фактор не подключён. */
export async function createStaffFixture(opts: {
  role: StaffRole;
  state?: 'active' | 'passive';
}): Promise<StaffFixture> {
  const email = `staff-${next()}@smartup.example`;
  const password = `pass-${next()}-long-enough`;
  const userId = (
    await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Сотрудник', $1, true) returning id`, [
      email,
    ])
  ).rows[0].id as string;
  await pools.root.query(
    `insert into auth.account ("accountId", "providerId", "userId", password, "updatedAt") values ($1::text, 'credential', $1::uuid, $2, now())`,
    [userId, await hashPassword(password)],
  );
  await pools.root.query(`insert into hdu_staff (user_id, role, state) values ($1, $2, $3)`, [
    userId,
    opts.role,
    opts.state ?? 'active',
  ]);
  return { userId, email, password, totpSecret: '' };
}

/** Сотрудник с подключённым вторым фактором: подключение проходит вызовами библиотеки. */
export async function enrolledStaffFixture(auth: TestAuth, opts: { role: StaffRole }): Promise<StaffFixture> {
  const staff = await createStaffFixture(opts);
  const signIn = await auth.api.signInEmail({
    body: { email: staff.email, password: staff.password },
    headers: new Headers(),
    returnHeaders: true,
  });
  let cookie = cookieOf(signIn.headers);
  const enabled = await auth.api.enableTwoFactor({ body: { password: staff.password }, headers: withCookie(cookie) });
  if (enabled.method !== 'totp') throw new Error('Ожидался второй фактор TOTP');
  const totpSecret = new URL(enabled.totpURI).searchParams.get('secret') as string;
  const verified = await auth.api.verifyTOTP({
    body: { code: totp(totpSecret) },
    headers: withCookie(cookie),
    returnHeaders: true,
  });
  cookie = cookieOf(verified.headers, cookie);
  await auth.api.signOut({ headers: withCookie(cookie) });
  return { ...staff, totpSecret };
}

/** Заголовки запроса после одного пароля: кука ожидания второго фактора, сессии ещё нет. */
export async function passwordStep(auth: TestAuth, staff: StaffFixture): Promise<Headers> {
  const signIn = await auth.api.signInEmail({
    body: { email: staff.email, password: staff.password },
    headers: new Headers(),
    returnHeaders: true,
  });
  return withCookie(cookieOf(signIn.headers));
}

/** Заголовки запроса после полного входа: пароль и код. */
export async function staffHeaders(auth: TestAuth, staff: StaffFixture): Promise<Headers> {
  const pending = await passwordStep(auth, staff);
  const verified = await auth.api.verifyTOTP({
    body: { code: totp(staff.totpSecret) },
    headers: pending,
    returnHeaders: true,
  });
  return withCookie(cookieOf(verified.headers, pending.get('cookie') ?? ''));
}

/** Клиент, которому подложили пароль: строки сотрудника у него нет. */
export async function createClientWithPasswordFixture(): Promise<{ userId: string; email: string; password: string }> {
  const email = `client-${next()}@acme.test`;
  const password = `pass-${next()}-long-enough`;
  const userId = (
    await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Клиент', $1, true) returning id`, [
      email,
    ])
  ).rows[0].id as string;
  await pools.root.query(
    `insert into auth.account ("accountId", "providerId", "userId", password, "updatedAt") values ($1::text, 'credential', $1::uuid, $2, now())`,
    [userId, await hashPassword(password)],
  );
  return { userId, email, password };
}

export type ServerFixtureInput = {
  code: string;
  issuer?: string;
  baseUrl?: string;
  clientSecret?: string;
  isDefault?: boolean;
  roleMap?: Record<string, string>;
  state?: 'active' | 'passive';
};

/** Сервер Smartup в реестре, секрет запечатан настоящим ключом. */
export async function addServerFixture(input: ServerFixtureInput): Promise<{ serverId: string; code: string }> {
  const issuer = input.issuer ?? `https://id.${input.code}.example`;
  const r = await pools.root.query(
    `insert into hdu_servers (name, base_url, issuer, oauth_client_id, oauth_client_secret, is_default, role_map, state, code)
     values ($1, $2, $3, 'hub', $4, $5, $6, $7, $8) returning server_id`,
    [
      `Сервер ${input.code}`,
      input.baseUrl ?? `https://${input.code}.smartup.example`,
      issuer,
      getSecretBox().seal(input.clientSecret ?? 'fixture-client-secret', `hdu_servers:${input.code}`),
      input.isDefault ?? false,
      JSON.stringify(input.roleMap ?? {}),
      input.state ?? 'active',
      input.code,
    ],
  );
  return { serverId: r.rows[0].server_id as string, code: input.code };
}

/** Организация для клиентов, которым в тесте важно только то, что членство есть. */
export async function ensureOrg(name = 'Fixture Org'): Promise<string> {
  const server = await addServerFixture({ code: `org-${serial + 1}-${Date.now().toString(36)}`.slice(0, 30) });
  serial += 1;
  const r = await pools.root.query(
    `insert into hdu_organizations (server_id, external_company_id, name) values ($1, $2, $3) returning org_id`,
    [server.serverId, `c-${next()}`, name],
  );
  return r.rows[0].org_id as string;
}

export async function addMembership(userId: string, orgId: string, role = 'client_user', source = 'invite'): Promise<void> {
  await pools.root.query(`insert into hdu_memberships (org_id, user_id, role, source) values ($1, $2, $3, $4)`, [
    orgId,
    userId,
    role,
    source,
  ]);
}

/**
 * Клиент с подтверждённым адресом. По умолчанию состоит в новой организации;
 * orgId кладёт его в указанную, memberships: 0 оставляет без членства.
 */
export async function verifiedClientFixture(
  email: string,
  opts: { orgId?: string; memberships?: 0 } = {},
): Promise<{ userId: string; email: string }> {
  const userId = (
    await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('Клиент', $1, true) returning id`, [
      email.trim().toLowerCase(),
    ])
  ).rows[0].id as string;
  if (opts.memberships !== 0) await addMembership(userId, opts.orgId ?? (await ensureOrg()));
  return { userId, email: email.trim().toLowerCase() };
}
