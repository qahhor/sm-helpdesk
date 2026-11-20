'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  addServer,
  checkServer,
  disableServer,
  enableServer,
  isHduError,
  requireStaffActor,
  type StaffContext,
  updateServer,
} from '@/modules/hdu/api';

// Действия реестра серверов в разделе "Настройки". Права и свежесть входа проверяет модуль:
// изменения только admin со входом не старше 15 минут, проверка связи без требования свежести.

export type ServerFormValues = Record<
  'code' | 'name' | 'baseUrl' | 'issuer' | 'clientId' | 'isDefault' | 'roleMap' | 'authorization' | 'token' | 'userinfo' | 'jwks',
  string
>;
export type ServerFormState = { error?: string; reauth?: boolean; values?: ServerFormValues };

const KNOWN_ERRORS = new Set(['invalid_input', 'server_taken', 'stale_session', 'forbidden', 'not_found']);
const ENDPOINTS = ['authorization', 'token', 'userinfo', 'jwks'] as const;

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * Строки "роль в Smartup = роль портала" в объект. Строка без знака "=" или с пустой частью даёт
 * пустую роль портала: её отклонит схема модуля, и форма покажет ошибку.
 */
function parseRoleMap(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const at = line.indexOf('=');
    const role = (at < 0 ? line : line.slice(0, at)).trim();
    map[role || line.trim()] = at < 0 ? '' : line.slice(at + 1).trim();
  }
  return map;
}

/** Добавление или изменение сервера. Секрет в ответ не возвращается: при ошибке его вводят снова. */
export async function saveServerAction(_previous: ServerFormState, formData: FormData): Promise<ServerFormState> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const locale = await getLocale();
  const t = await getTranslations('agent.settings.servers');
  const mode = field(formData, 'mode') === 'edit' ? 'edit' : 'new';
  const values: ServerFormValues = {
    code: field(formData, 'code'),
    name: field(formData, 'name'),
    baseUrl: field(formData, 'baseUrl'),
    issuer: field(formData, 'issuer'),
    clientId: field(formData, 'clientId'),
    isDefault: formData.get('isDefault') === 'on' ? 'on' : '',
    roleMap: field(formData, 'roleMap'),
    authorization: field(formData, 'authorization'),
    token: field(formData, 'token'),
    userinfo: field(formData, 'userinfo'),
    jwks: field(formData, 'jwks'),
  };
  const anyEndpoint = ENDPOINTS.some((name) => values[name].trim() !== '');
  const endpoints = anyEndpoint ? Object.fromEntries(ENDPOINTS.map((name) => [name, values[name]])) : null;
  const input = {
    code: values.code,
    name: values.name,
    baseUrl: values.baseUrl,
    issuer: values.issuer,
    clientId: values.clientId,
    clientSecret: field(formData, 'clientSecret'),
    isDefault: values.isDefault === 'on',
    roleMap: parseRoleMap(values.roleMap),
  };
  try {
    if (mode === 'new') await addServer(staff, { ...input, ...(endpoints && { endpoints }) });
    else await updateServer(staff, { ...input, endpoints });
  } catch (error) {
    if (!isHduError(error)) throw error;
    const code = KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input';
    return { error: t(`errors.${code}`), reauth: code === 'stale_session', values };
  }
  redirect(`/${locale}/agent/settings/servers/${values.code}?done=${mode === 'new' ? 'added' : 'saved'}`);
}

/** Кнопки карточки сервера: проверка связи, отключение и включение. Ошибка показывается кодом в адресе. */
async function run(formData: FormData, action: (staff: StaffContext, code: string) => Promise<unknown>, done: string): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const locale = await getLocale();
  // Код проверяет модуль. В адрес он идёт экранированным: неверный код откроет страницу 404.
  const code = field(formData, 'code');
  const page = `/${locale}/agent/settings/servers/${encodeURIComponent(code)}`;
  try {
    await action(staff, code);
  } catch (error) {
    if (!isHduError(error)) throw error;
    redirect(`${page}?error=${KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input'}`);
  }
  redirect(`${page}?done=${done}`);
}

/** Проверка связи (FR-ADM-01): результат запоминается и показывается на карточке. */
export async function checkServerAction(formData: FormData): Promise<void> {
  await run(formData, (staff, code) => checkServer(staff.actor, code), 'checked');
}

/** Отключение сервера после подтверждения: вход через него закрывается. */
export async function disableServerAction(formData: FormData): Promise<void> {
  await run(formData, (staff, code) => disableServer(staff, code), 'disabled');
}

/** Включение отключённого сервера. */
export async function enableServerAction(formData: FormData): Promise<void> {
  await run(formData, (staff, code) => enableServer(staff, code), 'enabled');
}
