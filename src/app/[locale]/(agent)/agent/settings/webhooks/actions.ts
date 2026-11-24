'use server';

import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';
import { createWebhook, deleteWebhook, isHdwError, rotateWebhookSecret, sendTestWebhook, updateWebhook } from '@/modules/hdw/api';

// Действия раздела "Вебхуки" (FR-AUTO-10, FR-ADM-11; план M8, задача 5). Права, свежесть входа, данные и адрес
// проверяет модуль hdw. Секрет подписи возвращается только в ответе на создание адреса и на смену секрета: страница
// показывает его из состояния формы, после перезагрузки его уже нет нигде.

const KNOWN_ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'invalid_url', 'not_found', 'endpoint_disabled', 'too_many']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type WebhookFormValues = { name: string; url: string; events: string[]; isEnabled: boolean };
export type WebhookFormState = { error?: string; reauth?: boolean; values?: WebhookFormValues; created?: { endpointId: string; secret: string } };
export type SecretState = { error?: string; reauth?: boolean; secret?: string };

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

async function failure(error: unknown): Promise<{ error: string; reauth: boolean }> {
  if (!isHdwError(error)) throw error;
  const t = await getTranslations('agent.settings.webhooks');
  const code = KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input';
  return { error: t(`errors.${code}`), reauth: code === 'stale_session' };
}

/**
 * Добавить адрес или изменить существующий. Новый адрес: в состоянии формы возвращается секрет подписи, форма
 * показывает его один раз. Правка: переход на страницу адреса.
 */
export async function saveWebhookAction(_previous: WebhookFormState, form: FormData): Promise<WebhookFormState> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const locale = await getLocale();
  const endpointId = text(form, 'endpointId');
  const values: WebhookFormValues = {
    name: text(form, 'name'),
    url: text(form, 'url'),
    events: form.getAll('events').filter((value): value is string => typeof value === 'string'),
    isEnabled: form.get('isEnabled') === 'on',
  };
  try {
    if (endpointId === '') return { created: await createWebhook(staff, values) };
    await updateWebhook(staff, { endpointId, ...values });
  } catch (error) {
    return { ...(await failure(error)), values };
  }
  redirect(`/${locale}/agent/settings/webhooks/${endpointId}?done=saved`);
}

/** Сменить секрет подписи: новый секрет возвращается в состоянии и показывается один раз. */
export async function rotateSecretAction(_previous: SecretState, form: FormData): Promise<SecretState> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  try {
    return await rotateWebhookSecret(staff, { endpointId: text(form, 'endpointId') });
  } catch (error) {
    return failure(error);
  }
}

async function run(form: FormData, action: (staff: StaffContext, endpointId: string) => Promise<unknown>, done: string, toList: boolean): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const list = `/${await getLocale()}/agent/settings/webhooks`;
  const endpointId = text(form, 'endpointId');
  // Отказ показывается на странице адреса, если идентификатор похож на настоящий.
  const page = UUID.test(endpointId) ? `${list}/${endpointId}` : list;
  try {
    await action(staff, endpointId);
  } catch (error) {
    if (!isHdwError(error)) throw error;
    redirect(`${page}?error=${KNOWN_ERRORS.has(error.code) ? error.code : 'invalid_input'}`);
  }
  redirect(`${toList ? list : page}?done=${done}`);
}

/** Проверочная отправка: событие test с образцом тела. Итог виден в журнале доставок. */
export async function sendTestAction(form: FormData): Promise<void> {
  await run(form, (staff, endpointId) => sendTestWebhook(staff, { endpointId }), 'tested', false);
}

export async function deleteWebhookAction(form: FormData): Promise<void> {
  await run(form, (staff, endpointId) => deleteWebhook(staff, { endpointId }), 'deleted', true);
}
