// Группы верхней панели рабочего места (ТЗ, раздел 8.11, таблица групп по этапам).
// Группы видны всегда: привычный порядок у сотрудников не меняется.
// Пункт появляется, когда его веха включена. Подписи: agent.nav.groups.<key> и agent.nav.items.<key>.

export type AgentNavItem = { key: string; href: string; availableFrom: string };
export type AgentNavGroup = {
  key: 'work' | 'knowledge' | 'clients' | 'analytics' | 'settings';
  items: readonly AgentNavItem[];
};

export const AGENT_NAV_GROUPS: readonly AgentNavGroup[] = [
  { key: 'work', items: [{ key: 'queues', href: '/agent/queues', availableFrom: 'M3' }] },
  {
    key: 'knowledge',
    items: [
      { key: 'solutions', href: '/agent/solutions', availableFrom: 'M5' },
      { key: 'candidates', href: '/agent/candidates', availableFrom: 'M5c' },
      { key: 'problems', href: '/agent/problems', availableFrom: 'M5c' },
      { key: 'codeKnowledge', href: '/agent/code-knowledge', availableFrom: 'M8c' },
    ],
  },
  {
    key: 'clients',
    items: [
      { key: 'organizations', href: '/agent/organizations', availableFrom: 'M1' },
      { key: 'ideas', href: '/agent/ideas', availableFrom: 'M7' },
      { key: 'announcements', href: '/agent/announcements', availableFrom: 'M5c' },
    ],
  },
  {
    key: 'analytics',
    items: [
      { key: 'metrics', href: '/agent/metrics', availableFrom: 'M8' },
      { key: 'digests', href: '/agent/digests', availableFrom: 'M8b' },
      { key: 'aiReview', href: '/agent/ai-review', availableFrom: 'M5b' },
    ],
  },
  { key: 'settings', items: [{ key: 'all', href: '/agent/settings', availableFrom: 'M8' }] },
];

/** Включённые вехи. Каждая веха, которая приносит раздел рабочего места, добавляет сюда свой код. */
export const ENABLED_MILESTONES: ReadonlySet<string> = new Set(['M0', 'M1']);

/** Пункты группы, чьи вехи включены. */
export function visibleItems(group: AgentNavGroup, enabled: ReadonlySet<string>): readonly AgentNavItem[] {
  return group.items.filter((item) => enabled.has(item.availableFrom));
}
