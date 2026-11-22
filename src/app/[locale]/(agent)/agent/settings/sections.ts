import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { SettingsSection } from '@/ui/components/SettingsLayout';

// Разделы "Настроек". Сроки и рабочее время с вехи M3, уведомления и почта с вехи M4, AI-помощник появится со своей вехой.
const SECTIONS = [
  { key: 'servers', href: '/agent/settings/servers' },
  { key: 'staff', href: '/agent/settings/staff' },
  { key: 'sla', href: '/agent/settings/sla' },
  { key: 'templates', href: '/agent/settings/templates' },
  { key: 'mail', href: '/agent/settings/mail' },
  { key: 'audit', href: '/agent/settings/audit' },
] as const;

export type SettingsSectionKey = (typeof SECTIONS)[number]['key'];

/** Разделы с подписями на языке страницы и подпись выпадающего списка для открытого раздела. */
export async function settingsNav(current: SettingsSectionKey | null) {
  const t = await getTranslations('agent.settings');
  const sections: SettingsSection[] = SECTIONS.map((section) => ({ ...section, label: t(`sections.${section.key}.title`) }));
  const open = sections.find((section) => section.key === current);
  return { sections, current, label: t('sectionsLabel'), menuLabel: open ? t('sectionsMenu', { name: open.label }) : t('title') };
}
