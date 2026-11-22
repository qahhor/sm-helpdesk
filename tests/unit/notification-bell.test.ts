import { expect, test } from 'vitest';
import { bellText } from '@/ui/shell/bell-text';

// Подпись колокольчика (FR-NT-03, WCAG 2.5.3): видимое число входит в подпись для диктора, в том числе "99+".

const labels = { none: 'Уведомления, нового нет', some: 'Уведомления, новых: {count}' };

test.each([
  [0, { label: 'Уведомления, нового нет', badge: null }],
  [3, { label: 'Уведомления, новых: 3', badge: '3' }],
  [99, { label: 'Уведомления, новых: 99', badge: '99' }],
  [148, { label: 'Уведомления, новых: 99+', badge: '99+' }],
])('%i непрочитанных', (count, expected) => {
  const text = bellText(count, labels);
  expect(text).toEqual(expected);
  if (text.badge) expect(text.label).toContain(text.badge);
});
