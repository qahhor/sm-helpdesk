'use server';

import { redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { requestEmailConfirmation, requireClientActor } from '@/modules/hdu/api';

/** Раздел "Email для входа": письмо со ссылкой подтверждения адреса (FR-ID-07). */
export async function requestEmailConfirmationAction(formData: FormData): Promise<void> {
  const locale = await getLocale();
  const client = await requireClientActor();
  const result = await requestEmailConfirmation(client, { email: formData.get('email'), locale });
  redirect(`/${locale}/settings?email=${result.ok ? 'sent' : result.code}`);
}
