import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { SlaBadge, slaLabelKey } from '@/ui/agent/SlaBadge';

// Срок в очереди: текстом и цветом, три состояния (UX-A-08, FR-SLA-06).

test('SlaBadge: спокойно, скоро при остатке меньше 20%, нарушен; цвет из токенов, состояние текстом', () => {
  const calm = renderToStaticMarkup(<SlaBadge phase="calm" label="3 ч" />);
  const soon = renderToStaticMarkup(<SlaBadge phase="soon" label="9 мин" />);
  const breached = renderToStaticMarkup(<SlaBadge phase="breached" label="нарушен" />);
  expect(calm).toContain('data-sla="calm"');
  expect(calm).toContain('bg-label-gray-bg');
  expect(soon).toContain('bg-label-orange-bg');
  expect(breached).toContain('bg-destructive-bg');
  for (const [html, text] of [
    [calm, '3 ч'],
    [soon, '9 мин'],
    [breached, 'нарушен'],
  ] as const)
    expect(html).toContain(text);
});

test('подпись срока: минуты до часа, часы до суток рабочего времени, нарушен при нуле', () => {
  expect(slaLabelKey(41)).toEqual({ key: 'minutes', value: 41 });
  expect(slaLabelKey(60)).toEqual({ key: 'hours', value: 1 });
  expect(slaLabelKey(179)).toEqual({ key: 'hours', value: 2 });
  expect(slaLabelKey(0)).toEqual({ key: 'breached', value: 0 });
  expect(slaLabelKey(null)).toEqual({ key: 'none', value: 0 });
});
