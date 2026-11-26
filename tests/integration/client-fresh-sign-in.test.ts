import { expect, test } from 'vitest';
import { requestEmailConfirmation } from '@/modules/hdu/api/email';
import { type ClientContext, resolveClient } from '@/modules/hdu/api/orgs';
import type { SessionData } from '@/modules/hdu/api/request';
import { revokeMySession, revokeOtherSessions } from '@/modules/hdu/api/sessions';
import { isHduError } from '@/modules/hdu/error';
import { clientSession, reload, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { memoryMailerPerTest } from './helpers/mail';
import { seedTwoOrgs } from './isolation/fixture';

// Недавний вход клиента перед сменой адреса почты и завершением сессий (ASVS 5.0.0, 7.5.1 и 7.5.2;
// ответ владельца 26.11.2026, решение 0067). Окно то же, что у настроек сотрудников: 15 минут.

const box = memoryMailerPerTest();

/** Сессия, в которой личность подтверждена minutes минут назад. */
async function aged(session: SessionData, minutes: number): Promise<SessionData> {
  await pools.root.query(`update auth.session set "freshAuthAt" = now() - make_interval(mins => $1) where id = $2`, [minutes, session.session.id]);
  return (await reload(session)) as SessionData;
}

const clientOf = async (session: SessionData) => (await resolveClient(session)) as ClientContext;

async function staleCode(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (isHduError(error)) return error.code;
    throw error;
  }
}

test('адрес для входа: письмо уходит при входе не старше 15 минут, позже просит войти заново', async () => {
  const f = await seedTwoOrgs();
  const fresh = await aged(await clientSession(f.aUser), 14);
  expect(await requestEmailConfirmation(await clientOf(fresh), { email: 'fresh@acme.test', locale: 'ru' })).toEqual({ ok: true });
  const stale = await aged(await clientSession(f.aUser), 16);
  expect(await requestEmailConfirmation(await clientOf(stale), { email: 'stale@acme.test', locale: 'ru' })).toEqual({ ok: false, code: 'stale_session' });
  expect(box.mailer.sent.map((mail) => mail.to)).toEqual(['fresh@acme.test']);
});

test('завершение другой сессии и всех других сессий требует недавнего входа клиента', async () => {
  const f = await seedTwoOrgs();
  const stale = await aged(await clientSession(f.aUser), 16);
  const other = await clientSession(f.aUser);
  expect(await staleCode(() => revokeMySession(stale, other.session.id))).toBe('stale_session');
  expect(await staleCode(() => revokeOtherSessions(stale))).toBe('stale_session');
  expect(await reload(other)).not.toBeNull();

  const fresh = await aged(await clientSession(f.aUser), 1);
  expect(await revokeMySession(fresh, other.session.id)).toEqual({ signedOut: false });
  expect(await revokeOtherSessions(fresh)).toEqual({ revoked: 1 });
  expect(await reload(stale)).toBeNull();
  expect(await reload(fresh)).not.toBeNull();
});

test('выход завершением своей сессии не требует недавнего входа', async () => {
  const f = await seedTwoOrgs();
  const stale = await aged(await clientSession(f.aUser), 120);
  expect(await revokeMySession(stale, stale.session.id)).toEqual({ signedOut: true });
  expect(await reload(stale)).toBeNull();
});

test('сотрудник завершает свои сессии, как раньше, без нового правила', async () => {
  const member = await staffWithRole('care');
  const stale = await aged(await clientSession(member), 120);
  const other = await clientSession(member);
  expect(await revokeMySession(stale, other.session.id)).toEqual({ signedOut: false });
  await clientSession(member);
  expect(await revokeOtherSessions(stale)).toEqual({ revoked: 1 });
});
