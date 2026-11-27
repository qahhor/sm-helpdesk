import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

// Разделы "Знания из кода" (8.12, FR-ADM-15): очередь утверждения, история сканирований, карта модулей.

const TABS = [
  { key: 'queue', href: '/agent/code-knowledge' },
  { key: 'scans', href: '/agent/code-knowledge/scans' },
  { key: 'modules', href: '/agent/code-knowledge/modules' },
] as const;

export async function CodeTabs({ current }: { current: (typeof TABS)[number]['key'] }) {
  const t = await getTranslations('agent.codeKnowledge.tabs');
  return (
    <nav aria-label={t('label')} className="flex flex-wrap gap-2">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? 'page' : undefined}
          className={`inline-flex min-h-control items-center rounded-chip border px-4 text-sm font-medium ${tab.key === current ? 'border-primary bg-selected text-selected-foreground' : 'border-border bg-card text-foreground hover:bg-card-soft'}`}
        >
          {t(tab.key)}
        </Link>
      ))}
    </nav>
  );
}
