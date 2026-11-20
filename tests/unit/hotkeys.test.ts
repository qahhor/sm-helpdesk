import { expect, test } from 'vitest';
import { HOTKEYS } from '@/ui/hotkeys/registry';

test('клавиши Smartup Web из UX-S-14 и палитра на двух сочетаниях', () => {
  const keys = HOTKEYS.map((h) => h.keys);
  for (const k of ['F2', 'F3', 'F4', 'F7', 'Alt+A', 'Alt+E', 'Alt+S', 'Alt+Q', 'Ctrl+Enter', 'Ctrl+K'])
    expect(keys).toContain(k);
  // F8 и F9 в портале не используются: решение владельца от 20.11.2026 (ТЗ 1.1, UX-S-14).
  expect(keys).not.toContain('F8');
  expect(keys).not.toContain('F9');
  expect(new Set(keys).size).toBe(keys.length);
  const palette = HOTKEYS.filter((h) => h.action === 'palette.open')
    .map((h) => h.keys)
    .sort();
  expect(palette).toEqual(['Ctrl+K', 'F2']);
});

test('действия совпадают с окном "Горячие клавиши" Smartup Web', () => {
  const action = (keys: string) => HOTKEYS.find((h) => h.keys === keys)?.action;
  expect(action('F3')).toBe('table.search');
  expect(action('F4')).toBe('table.filter');
  expect(action('F7')).toBe('table.refresh');
  expect(action('Alt+A')).toBe('record.add');
  expect(action('Alt+E')).toBe('record.edit');
  expect(action('Alt+S')).toBe('form.save');
  expect(action('Alt+Q')).toBe('page.close');
  expect(action('Ctrl+Enter')).toBe('form.complete');
});
