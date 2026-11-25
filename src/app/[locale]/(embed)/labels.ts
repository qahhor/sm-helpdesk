import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { WidgetLabels } from '@/ui/widget/session';

// Тексты страниц виджета (план M6, задачи 5-7): переводятся на сервере и приходят странице готовыми строками, как
// в кабинете. Библиотека сообщений в браузер не уходит (бюджет 170 КБ на телефоне). Подстановки {name} заменяет fill.

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix: string, into: WidgetLabels): WidgetLabels {
  for (const [key, value] of Object.entries(tree)) {
    const path = `${prefix}.${key}`;
    if (typeof value === 'string') into[path] = value;
    else flatten(value, path, into);
  }
  return into;
}

export async function widgetLabels(): Promise<WidgetLabels> {
  const t = await getTranslations();
  const labels: WidgetLabels = {};
  const parts: [string, string][] = [
    ['panel', 'widget.panel'],
    ['report', 'widget.report'],
    ['solution', 'widget.solution'],
    ['files', 'client.tickets.files'],
    ['errors', 'client.tickets.errors'],
    ['feedback', 'client.solution.feedback'],
    ['view', 'client.solution.view'],
    ['languages', 'client.solution.languages'],
  ];
  for (const [prefix, namespace] of parts) flatten(t.raw(namespace) as Tree, prefix, labels);
  labels['solution.notTranslated'] = t.raw('client.solution.notTranslated') as string;
  return labels;
}
