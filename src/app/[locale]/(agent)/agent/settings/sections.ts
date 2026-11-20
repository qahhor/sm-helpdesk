import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { SettingsSection } from '@/ui/components/SettingsLayout';

// Разделы "Настроек" вехи M1. Журнал аудита (задача 20) добавляет свою строку,
// SLA, AI-помощник и почта появляются со своими вехами.
const SECTIONS = [
  { key: 'servers', href: '/agent/settings/servers' },
  { key: 'staff', href: '/agent/settings/staff' },
] as const;

export type SettingsSectionKey = (typeof SECTIONS)[number]['key'];

/** Разделы с подписями на языке страницы и подпись выпадающего списка для открытого раздела. */
export async function settingsNav(current: SettingsSectionKey | null) {
  const t = await getTranslations('agent.settings');
  const sections: SettingsSection[] = SECTIONS.map((section) => ({ ...section, label: t(`sections.${section.key}.title`) }));
  const open = sections.find((section) => section.key === current);
  return { sections, current, label: t('sectionsLabel'), menuLabel: open ? t('sectionsMenu', { name: open.label }) : t('title') };
}
