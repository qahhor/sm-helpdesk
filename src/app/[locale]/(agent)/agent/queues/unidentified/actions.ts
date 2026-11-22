'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { bindTicket, isHdtError, markNotClient, markSpam } from '@/modules/hdt/api';
import { requireStaffActor, type StaffContext } from '@/modules/hdu/api';

// Действия очереди "Неопознанные" (план M4, задача 11): привязать и пригласить, "Это не клиент", "Спам". Права и данные
// проверяет модуль hdt, итог показывается кодом в адресе страницы.

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

async function run(form: FormData, action: (staff: StaffContext, number: number) => Promise<string>): Promise<never> {
  const staff = await requireStaffActor();
  const page = `/${await getLocale()}/agent/queues/unidentified`;
  const number = Number(text(form, 'number'));
  let done: string;
  try {
    done = await action(staff, number);
  } catch (error) {
    if (!isHdtError(error)) throw error;
    redirect(`${page}?number=${Number.isInteger(number) ? number : ''}&error=${error.code}`);
  }
  redirect(`${page}?done=${done}`);
}

export async function bindAction(form: FormData): Promise<void> {
  await run(form, async (staff, number) => ((await bindTicket(staff, { number, orgId: text(form, 'orgId') })).invited ? 'bound' : 'boundNoInvite'));
}

export async function notClientAction(form: FormData): Promise<void> {
  await run(form, async (staff, number) => {
    await markNotClient(staff, number);
    return 'notClient';
  });
}

export async function spamAction(form: FormData): Promise<void> {
  await run(form, async (staff, number) => {
    await markSpam(staff, number);
    return 'spam';
  });
}
