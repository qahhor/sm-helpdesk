import 'server-only';
import { getTranslations } from 'next-intl/server';
import { WEBHOOK_EVENTS } from '@/modules/hdw/api';
import type { SecretLabels } from './SecretOnce';
import type { WebhookFormLabels } from './WebhookForm';

// Подписи формы адреса вебхука и блока секрета на языке страницы: клиентские компоненты получают готовые строки.

export async function secretLabels(): Promise<SecretLabels> {
  const w = await getTranslations('agent.settings.webhooks.secret');
  return { title: w('title'), text: w('text'), label: w('label'), copy: w('copy'), copied: w('copied'), howTitle: w('howTitle'), how: w('how') };
}

export async function webhookFormProps(mode: 'new' | 'edit'): Promise<{ labels: WebhookFormLabels; events: { value: string; label: string }[] }> {
  const w = await getTranslations('agent.settings.webhooks');
  const r = await getTranslations('agent.settings.rules');
  return {
    events: WEBHOOK_EVENTS.map((value) => ({ value, label: r(`events.${value}`) })),
    labels: {
      name: w('form.name'),
      nameHint: w('form.nameHint'),
      url: w('form.url'),
      urlHint: w('form.urlHint'),
      events: w('form.events'),
      eventsHint: w('form.eventsHint'),
      enabled: w('form.enabled'),
      submit: w(mode === 'new' ? 'form.create' : 'form.save'),
      reauth: w('reauth'),
      openEndpoint: w('secret.openEndpoint'),
      secret: await secretLabels(),
    },
  };
}
