import 'server-only';
import { redeemAllowed } from './redeem-limit';
import { z } from 'zod';
import { getEnv } from '@/env';
import { LOCALES } from '@/i18n/locales';
import { RATE_RULES } from '@/modules/hdc/pref';
import { clientIp, consumeRateLimit, rateKey } from '@/modules/hdc/api';
import { invitationMail, queueMail } from '@/modules/hdn/api';
import { acceptInvitationTx, createInvitation, findPendingInvitation, listOrgInvitations, revokeOrgInvitation } from '../core/invitations';
import { findActiveOrgName } from '../core/members';
import { createTrustedSession } from '../core/trusted';
import { HduError } from '../error';
import { emailInput, nameInput, parseInput, tokenInput, uuidInput } from '../input';
import { CLIENT_ROLES, type ClientRole } from '../pref';
import { hashToken } from '../tokens';
import { setActiveOrganization } from '../core/orgs';
import { readSession, type RequestInfo } from './request';
import { manageScope, type OrgScope } from './scope';

// Приглашения в организацию клиента (FR-ID-08, FR-ID-13, решение 0014).

export type InvitationView = {
  invitationId: string;
  email: string;
  role: ClientRole;
  expiresOn: Date;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
};

// Лишние ключи (например, подставленная организация) схема отбрасывает: организация берётся из области действия.
const inviteInput = z.object({ email: emailInput, role: z.enum(CLIENT_ROLES), locale: z.enum(LOCALES) });

/**
 * Приглашение: администратор клиента в свою организацию, care и admin в любую. Срок 7 дней,
 * 20 приглашений в час на организацию. Письмо на языке приглашающего, отправка ответ не задерживает.
 */
export async function inviteMember(scope: OrgScope, input: unknown): Promise<{ invitationId: string }> {
  const s = manageScope(scope);
  const parsed = inviteInput.safeParse(input);
  if (!parsed.success) throw new HduError('invalid_input');
  const orgName = s.orgName ?? (await findActiveOrgName(s.actor, s.orgId));
  if (!orgName) throw new HduError('not_found');
  const limit = await consumeRateLimit(rateKey('invitations:org', s.orgId), RATE_RULES.invitationsPerOrg);
  if (!limit.allowed) throw new HduError('rate_limited', { retryAfterSec: limit.retryAfterSec });

  const { email, role, locale } = parsed.data;
  const { invitationId, token } = await createInvitation(s.actor, { orgId: s.orgId, email, role });
  const url = new URL(`/${locale}/invite`, getEnv().HUB_URL);
  url.searchParams.set('token', token);
  queueMail({ to: email, kind: 'invitation', ...invitationMail(locale, { url: url.toString(), orgName, inviterName: s.actorName }) });
  return { invitationId };
}

function statusOf(row: { acceptedOn: Date | null; revokedOn: Date | null; expiresOn: Date }, now: Date): InvitationView['status'] {
  if (row.acceptedOn) return 'accepted';
  if (row.revokedOn) return 'revoked';
  return row.expiresOn.getTime() <= now.getTime() ? 'expired' : 'pending';
}

/** Приглашения организации со статусом. */
export async function listInvitations(scope: OrgScope): Promise<InvitationView[]> {
  const s = manageScope(scope);
  const now = new Date();
  return (await listOrgInvitations(s.actor, s.orgId)).map((row) => ({
    invitationId: row.invitationId,
    email: row.email,
    role: row.role,
    expiresOn: row.expiresOn,
    status: statusOf(row, now),
  }));
}

/** Отзыв ждущего приглашения. Чужое для актора не найдено. */
export async function revokeInvitation(scope: OrgScope, invitationId: unknown): Promise<void> {
  const s = manageScope(scope);
  await revokeOrgInvitation(s.actor, s.orgId, parseInput(uuidInput, invitationId));
}

/** Что показать на странице приглашения. Недействительная ссылка: пусто, без причины. */
export async function describeInvitation(token: unknown): Promise<{ orgName: string; email: string; needsName: boolean } | null> {
  const parsed = tokenInput.safeParse(token);
  if (!parsed.success) return null;
  const found = await findPendingInvitation(hashToken(parsed.data));
  return found ? { orgName: found.orgName, email: found.email, needsName: !found.hasAccount } : null;
}

const acceptInput = z.object({ token: tokenInput, name: z.unknown().optional() });

/**
 * Принятие приглашения нажатием кнопки на странице ссылки. Новая учётная запись получает сессию: ссылка
 * из письма проверила человека (createTrustedSession, решение 0012). Существующая учётная запись принимает
 * приглашение только из своей сессии (sign_in_required без входа, wrong_account в чужой сессии), и приглашённая
 * организация становится в этой сессии активной (проверка main, S3). Учётная запись, которой войти нечем,
 * получает сессию по ссылке, как новая (итоговая проверка доработки).
 */
export async function acceptInvitation(
  input: unknown,
  request: RequestInfo,
): Promise<{ ok: true } | { ok: false; code: 'link_invalid' | 'email_taken' | 'sign_in_required' | 'wrong_account' | 'rate_limited' }> {
  if (!(await redeemAllowed(clientIp(request.headers))).ok) return { ok: false, code: 'rate_limited' };
  const parsed = acceptInput.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'link_invalid' };
  const tokenHash = hashToken(parsed.data.token);
  const name = nameInput.safeParse(parsed.data.name);
  // Имя спрашивается только у новой учётной записи. Без имени её подписывает начало адреса.
  const fallback = (await findPendingInvitation(tokenHash))?.email.split('@')[0] ?? 'Smartup';
  const session = await readSession(request);
  const result = await acceptInvitationTx(tokenHash, name.success ? name.data : fallback, session?.user.id ?? null, clientIp(request.headers));
  if (typeof result === 'string') return { ok: false, code: result };
  if (result.signIn) await createTrustedSession(result.userId, 'invitation', request);
  else if (session) await setActiveOrganization({ sessionId: session.session.id, userId: result.userId }, result.orgId, { remember: true });
  return { ok: true };
}
