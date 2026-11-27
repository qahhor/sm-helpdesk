import 'server-only';
import { getTranslations } from 'next-intl/server';
import { AGENT_READ_TOOLS, AGENT_WRITE_TOOLS } from '@/modules/hda/api/agent-admin';
import type { TokenFormLabels, ToolOption } from './TokenForm';

// Подписи формы токена на языке страницы: клиентский компонент получает готовые строки.

/** Срок нового токена по умолчанию: 90 суток. */
const DEFAULT_DAYS = 90;

export async function tokenFormProps(
  mode: 'new' | 'edit',
): Promise<{ labels: TokenFormLabels; readTools: ToolOption[]; writeTools: ToolOption[]; defaultExpiresAt: string }> {
  const t = await getTranslations('agent.settings.agents');
  const option = (value: string): ToolOption => ({ value, label: t(`tools.${value}`) });
  return {
    defaultExpiresAt: new Date(Date.now() + DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10),
    readTools: AGENT_READ_TOOLS.map(option),
    writeTools: AGENT_WRITE_TOOLS.map(option),
    labels: {
      name: t('form.name'),
      nameHint: t('form.nameHint'),
      readTools: t('form.readTools'),
      writeTools: t('form.writeTools'),
      toolsHint: t('form.toolsHint'),
      allowedIps: t('form.allowedIps'),
      allowedIpsHint: t('form.allowedIpsHint'),
      expiresAt: t('form.expiresAt'),
      expiresAtHint: t('form.expiresAtHint'),
      dailyLimit: t('form.dailyLimit'),
      dailyLimitHint: t('form.dailyLimitHint'),
      submit: t(mode === 'new' ? 'form.issue' : 'form.save'),
      reauth: t('reauth'),
      issued: { title: t('issued.title'), text: t('issued.text'), label: t('issued.label'), copy: t('issued.copy'), copied: t('issued.copied'), open: t('issued.open') },
    },
  };
}
