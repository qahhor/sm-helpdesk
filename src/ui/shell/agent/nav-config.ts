// Группы верхней панели рабочего места (ТЗ, раздел 8.11, таблица групп по этапам).
// Группы видны всегда: привычный порядок у сотрудников не меняется.
// Пункт появляется, когда его веха включена и роль сотрудника в списке пункта (если список задан).
// Подписи: agent.nav.groups.<key> и agent.nav.items.<key>.

import type { StaffRole } from '@/modules/hdu/pref';

export type AgentNavItem = {
  key: string;
  href: string;
  availableFrom: string;
  /** Кому пункт виден. Не задано: всем сотрудникам. Страницы проверяют роль сами (requireStaffActor). */
  roles?: readonly StaffRole[];
};
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
      // Кандидаты в решения (веха M5c, решение 29): роли с правом черновика решения, product нет.
      { key: 'candidates', href: '/agent/candidates', availableFrom: 'M5c', roles: ['agent_l1', 'agent_l2', 'care', 'admin'] },
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
  { key: 'settings', items: [{ key: 'all', href: '/agent/settings', availableFrom: 'M1', roles: ['admin'] }] },
];

/** Включённые вехи. Каждая веха, которая приносит раздел рабочего места, добавляет сюда свой код. */
export const ENABLED_MILESTONES: ReadonlySet<string> = new Set(['M0', 'M1', 'M2', 'M3', 'M5', 'M5b', 'M5c', 'M7', 'M8', 'M8b']);

/** Пункты группы, чьи вехи включены и которые доступны роли сотрудника. Без роли (витрина): только общие пункты. */
export function visibleItems(group: AgentNavGroup, enabled: ReadonlySet<string>, role: StaffRole | null): readonly AgentNavItem[] {
  return group.items.filter((item) => enabled.has(item.availableFrom) && (!item.roles || (role !== null && item.roles.includes(role))));
}
