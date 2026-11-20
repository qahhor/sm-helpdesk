import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { AGENT_NAV_GROUPS, ENABLED_MILESTONES, visibleItems } from '@/ui/shell/agent/nav-config';

test('пять групп в порядке таблицы раздела 8.11 ТЗ', () => {
  expect(AGENT_NAV_GROUPS.map((g) => g.key)).toEqual(['work', 'knowledge', 'clients', 'analytics', 'settings']);
});

test('пункты будущих вех скрыты, группы остаются', () => {
  const work = AGENT_NAV_GROUPS[0];
  expect(visibleItems(work, new Set(['M0']), 'agent_l1')).toEqual([]);
  expect(visibleItems(work, new Set(['M0', 'M1', 'M2', 'M3']), 'agent_l1').map((i) => i.key)).toEqual(['queues']);
});

test('состав групп этапа 1 и вехи, в которых пункты появляются', () => {
  const items = Object.fromEntries(
    AGENT_NAV_GROUPS.map((g) => [g.key, g.items.map((i) => `${i.key}:${i.availableFrom}`)]),
  );
  expect(items).toEqual({
    work: ['queues:M3'],
    knowledge: ['solutions:M5', 'candidates:M5c', 'problems:M5c', 'codeKnowledge:M8c'],
    clients: ['organizations:M1', 'ideas:M7', 'announcements:M5c'],
    analytics: ['metrics:M8', 'digests:M8b', 'aiReview:M5b'],
    settings: ['all:M1'],
  });
});

test('включены вехи M0 и M1', () => {
  expect([...ENABLED_MILESTONES]).toEqual(['M0', 'M1']);
});

test('в вехе M1 в группе "Клиенты" есть пункт "Организации"', () => {
  const group = AGENT_NAV_GROUPS.find((g) => g.key === 'clients');
  expect(visibleItems(group!, ENABLED_MILESTONES, 'care').map((i) => i.key)).toEqual(['organizations']);
});

test('пункт "Все настройки" виден только администратору', () => {
  const settings = AGENT_NAV_GROUPS.find((g) => g.key === 'settings')!;
  expect(visibleItems(settings, ENABLED_MILESTONES, 'admin').map((i) => i.key)).toEqual(['all']);
  for (const role of ['agent_l1', 'agent_l2', 'care', 'product'] as const) expect(visibleItems(settings, ENABLED_MILESTONES, role)).toEqual([]);
});

test('у каждой группы и каждого пункта есть подпись на трёх языках', () => {
  for (const locale of ['ru', 'uz', 'en']) {
    const nav = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).agent.nav;
    for (const group of AGENT_NAV_GROUPS) {
      expect(nav.groups[group.key], `${locale} ${group.key}`).toBeTruthy();
      for (const item of group.items) expect(nav.items[item.key], `${locale} ${item.key}`).toBeTruthy();
    }
  }
});

test('у каждого действия журнала аудита есть подпись на трёх языках', async () => {
  const { AUDIT_ACTIONS } = await import('@/modules/hdc/pref');
  for (const locale of ['ru', 'uz', 'en']) {
    const actions = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).agent.settings.audit.actions;
    for (const action of AUDIT_ACTIONS) {
      const [group, name] = action.split('.') as [string, string];
      expect(actions[group]?.[name], `${locale} ${action}`).toBeTruthy();
    }
  }
});
