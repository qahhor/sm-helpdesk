'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { createTicketForClient, isHdtError } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';

// Обращение от имени клиента (FR-AG-08). Организацию, участника и поля проверяет модуль hdt, итог в адресе.

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

export async function createForClientAction(form: FormData): Promise<void> {
  const staff = await requireStaffActor({ roles: ['agent_l1', 'agent_l2', 'care', 'admin'] });
  const locale = await getLocale();
  const orgId = text(form, 'orgId');
  let number: number;
  try {
    ({ number } = await createTicketForClient(staff, {
      orgId,
      authorId: text(form, 'authorId'),
      type: text(form, 'type'),
      impact: text(form, 'impact'),
      priority: text(form, 'priority'),
      title: text(form, 'title'),
      description: String(form.get('description') ?? ''),
      moduleId: text(form, 'moduleId'),
      visibility: text(form, 'visibility'),
      locale: text(form, 'locale'),
      attachmentIds: form.getAll('attachmentIds').map(String),
    }));
  } catch (error) {
    if (!isHdtError(error)) throw error;
    redirect(`/${locale}/agent/tickets/new?org=${encodeURIComponent(orgId)}&error=${error.code}`);
  }
  redirect(`/${locale}/agent/tickets/SUP-${number}?done=created`);
}
