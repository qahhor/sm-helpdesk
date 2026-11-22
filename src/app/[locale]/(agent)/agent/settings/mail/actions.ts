'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { isHdnError, saveOncall, saveSupportAddresses, sendInboundTest, sendOncallTest, unblockSender } from '@/modules/hdn/api/mail-settings';
import { isHdtError, saveTimings } from '@/modules/hdt/api';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';

// Действия экрана "Уведомления и почта" (план M4, задача 12). Права и значения проверяют модули, итог показывается
// кодом в адресе страницы. Токен бота в адрес и журнал не попадает.

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const lines = (value: string) => value.split(/[\s,;]+/u).filter((item) => item !== '');

async function run(action: (staff: StaffContext) => Promise<string | void>, done: string): Promise<never> {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const page = `/${await getLocale()}/agent/settings/mail`;
  let result: string | void;
  try {
    result = await action(staff);
  } catch (error) {
    if (!isHdnError(error) && !isHdtError(error)) throw error;
    redirect(`${page}?error=${error.code}`);
  }
  redirect(result ? `${page}?error=${result}` : `${page}?done=${done}`);
}

/** Адреса поддержки: оставшиеся, новый и отмеченный показываемым. Единственный адрес показывается сам. */
export async function saveSupportAction(form: FormData): Promise<void> {
  await run(async (staff) => {
    const removed = new Set(form.getAll('remove').map(String));
    const list = form
      .getAll('address')
      .map(String)
      .filter((address) => !removed.has(address));
    const added = text(form, 'newAddress').toLowerCase();
    if (added && !list.includes(added)) list.push(added);
    const chosen = text(form, 'shown');
    const shown = list.includes(chosen) ? chosen : list.length === 1 ? list[0] : '';
    await saveSupportAddresses(
      staff,
      list.map((address) => ({ address, shown: address === shown })),
    );
  }, 'support');
}

export async function inboundTestAction(form: FormData): Promise<void> {
  await run((staff) => sendInboundTest(staff, text(form, 'address')), 'test');
}

export async function saveOncallAction(form: FormData): Promise<void> {
  await run(async (staff) => {
    const token = text(form, 'botToken');
    await saveOncall(staff, {
      emails: lines(text(form, 'emails')).map((email) => email.toLowerCase()),
      chatId: text(form, 'chatId') || null,
      bot: text(form, 'bot') === 'own' ? 'own' : 'main',
      ...(token ? { botToken: token } : {}),
    });
  }, 'oncall');
}

export async function oncallTestAction(): Promise<void> {
  await run(async (staff) => ((await sendOncallTest(staff)).ok ? undefined : 'oncallTest'), 'oncallTest');
}

export async function saveTimingsAction(form: FormData): Promise<void> {
  await run(
    (staff) =>
      saveTimings(staff, {
        waitingReminderDays: text(form, 'waitingReminderDays'),
        autocloseResolvedDays: text(form, 'autocloseResolvedDays'),
        autocloseWaitingDays: text(form, 'autocloseWaitingDays'),
        updateIntervalDays: text(form, 'updateIntervalDays'),
      }),
    'timings',
  );
}

export async function unblockAction(form: FormData): Promise<void> {
  await run((staff) => unblockSender(staff, text(form, 'address')), 'unblocked');
}
