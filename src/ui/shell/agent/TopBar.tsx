import { getTranslations } from 'next-intl/server';
import { localeNames } from '@/i18n/messages';
import { Link } from '@/i18n/navigation';
import { Logo } from '@/ui/brand/Logo';
import { LanguageSwitcher } from '@/ui/LanguageSwitcher';
import { ThemeSwitch } from '@/ui/theme/ThemeSwitch';
import { AGENT_NAV_GROUPS, ENABLED_MILESTONES, visibleItems } from './nav-config';
import { type NavGroupView, SectionsMenu } from './SectionsMenu';

/**
 * Верхняя панель рабочего места по образцу Smartup Web: тёмная в обеих темах, высота 52 px,
 * логотип для тёмного фона, пять групп разделов, справа язык и тема.
 */
export async function TopBar() {
  const t = await getTranslations();
  const groups: NavGroupView[] = AGENT_NAV_GROUPS.map((group) => ({
    key: group.key,
    label: t(`agent.nav.groups.${group.key}`),
    items: visibleItems(group, ENABLED_MILESTONES).map((item) => ({
      key: item.key,
      href: item.href,
      label: t(`agent.nav.items.${item.key}`),
    })),
  }));

  return (
    <header className="sticky top-0 z-40 flex h-header shrink-0 items-center gap-4 bg-header px-4 text-header-foreground">
      <Link href="/agent" className="inline-flex items-center rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Logo onDark withProductName />
      </Link>
      <nav aria-label={t('agent.nav.sections')} className="flex items-center">
        <SectionsMenu groups={groups} sectionsLabel={t('agent.nav.sections')} emptyLabel={t('agent.nav.soon')} />
      </nav>
      <div className="ms-auto flex items-center">
        <LanguageSwitcher names={await localeNames()} label={t('common.language.label')} />
        <ThemeSwitch
          labels={{
            label: t('common.theme.label'),
            light: t('common.theme.light'),
            dark: t('common.theme.dark'),
            system: t('common.theme.system'),
          }}
        />
      </div>
    </header>
  );
}
