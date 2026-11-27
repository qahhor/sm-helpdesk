'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { isHdaError, issueAgentToken, revokeAgentToken, saveTeamChat, setEventParent, updateAgentToken } from '@/modules/hda/api/agent-admin';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';

// Действия раздела "AI-сотрудники" (FR-AGT-02, FR-ADM-13, экран 8.12; план M8b, задача 3). Права, свежесть входа и
// данные проверяет модуль hda. Значение токена возвращается только в состоянии формы выпуска: страница показывает его
// один раз, после перезагрузки его нет нигде.

const KNOWN_ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TokenFormValues = { name: string; tools: string[]; allowedIps: string; expiresAt: string; dailyLimit: string };
export type TokenFormState = { error?: string; reauth?: boolean; values?: TokenFormValues; issued?: { tokenId: string; value: string } };

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

function values(form: FormData): TokenFormValues {
  return {
    name: text(form, 'name'),
    tools: form.getAll('tools').filter((value): value is string => typeof value === 'string'),
    allowedIps: text(form, 'allowedIps'),
    expiresAt: text(form, 'expiresAt'),
    dailyLimit: text(form, 'dailyLimit'),
  };
}

/** Поля формы в вход модуля: адреса по строкам и через запятую, предел числом. */
function toInput(data: TokenFormValues) {
  return {
    tools: data.tools,
    allowedIps: data.allowedIps
      .split(/[\s,]+/u)
      .map((line) => line.trim())
      .filter(Boolean),
    expiresAt: data.expiresAt,
    dailyLimit: /^\d{1,6}$/.test(data.dailyLimit.trim()) ? Number(data.dailyLimit.trim()) : Number.NaN,
  };
}

async function failure(error: unknown): Promise<{ error: string; reauth: boolean }> {
  if (!isHdaError(error)) throw error;
  const t = await getTranslations('agent.settings.agents');
  const code = KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input';
  return { error: t(`errors.${code}`), reauth: code === 'stale_session' };
}

/** Выпустить токен: в состоянии формы возвращается значение, форма показывает его один раз. */
export async function issueTokenAction(_previous: TokenFormState, form: FormData): Promise<TokenFormState> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const data = values(form);
  try {
    return { issued: await issueAgentToken(staff, { name: data.name, ...toInput(data) }) };
  } catch (error) {
    return { ...(await failure(error)), values: data };
  }
}

/** Изменить перечень, адреса, предел и срок: переход на страницу токена. */
export async function updateTokenAction(_previous: TokenFormState, form: FormData): Promise<TokenFormState> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const locale = await getLocale();
  const tokenId = text(form, 'tokenId');
  const data = values(form);
  try {
    await updateAgentToken(staff, { tokenId, ...toInput(data) });
  } catch (error) {
    return { ...(await failure(error)), values: data };
  }
  redirect(`/${locale}/agent/settings/agents/${tokenId}?done=saved`);
}

async function run(form: FormData, action: (staff: StaffContext, tokenId: string) => Promise<unknown>, done: string): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const list = `/${await getLocale()}/agent/settings/agents`;
  const tokenId = text(form, 'tokenId');
  const page = UUID.test(tokenId) ? `${list}/${tokenId}` : list;
  try {
    await action(staff, tokenId);
  } catch (error) {
    if (!isHdaError(error)) throw error;
    redirect(`${page}?error=${KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input'}`);
  }
  redirect(`${page}?done=${done}`);
}

export async function revokeTokenAction(form: FormData): Promise<void> {
  await run(form, (staff, tokenId) => revokeAgentToken(staff, { tokenId }), 'revoked');
}

/** Отметить токен "для событий" или снять отметку (поле clear). */
export async function eventParentAction(form: FormData): Promise<void> {
  const clear = form.get('clear') === '1';
  await run(form, (staff, tokenId) => setEventParent(staff, { tokenId: clear ? null : tokenId }), clear ? 'eventParentCleared' : 'eventParentSet');
}

/** Чат команды для сообщений по сводкам: пустое поле убирает настройку. */
export async function saveTeamChatAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const list = `/${await getLocale()}/agent/settings/agents`;
  try {
    await saveTeamChat(staff, { chatId: text(form, 'chatId') });
  } catch (error) {
    if (!isHdaError(error)) throw error;
    redirect(`${list}?error=${KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input'}#team-chat`);
  }
  redirect(`${list}?done=chatSaved#team-chat`);
}
