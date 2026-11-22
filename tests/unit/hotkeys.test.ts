import { expect, test } from 'vitest';
import { HOTKEYS, matchHotkey } from '@/ui/hotkeys/registry';

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

// Клавиши рабочего места (UX-A-01..04, UX-A-17; план M3, задача 14): буквы по физической клавише, чтобы работали
// и в русской раскладке; в полях ввода только сочетания с Ctrl.
const key = (k: string, code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key: k,
  code,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

test('клавиши не срабатывают в поле ввода, Ctrl-сочетания срабатывают', () => {
  expect(matchHotkey(key('r', 'KeyR'), false)).toBe('reply.focus');
  expect(matchHotkey(key('к', 'KeyR'), false)).toBe('reply.focus');
  expect(matchHotkey(key('n', 'KeyN'), false)).toBe('note.focus');
  expect(matchHotkey(key('t', 'KeyT'), false)).toBe('ticket.take');
  expect(matchHotkey(key('s', 'KeyS'), false)).toBe('ticket.snooze');
  expect(matchHotkey(key('ArrowDown', 'ArrowDown'), false)).toBe('list.next');
  expect(matchHotkey(key('ArrowUp', 'ArrowUp'), false)).toBe('list.prev');
  expect(matchHotkey(key('?', 'Slash', { shift: true }), false)).toBe('help.open');
  for (const [k, code] of [['r', 'KeyR'], ['ArrowDown', 'ArrowDown'], ['?', 'Slash']] as const)
    expect(matchHotkey(key(k, code, k === '?' ? { shift: true } : {}), true), k).toBeNull();
  expect(matchHotkey(key('Enter', 'Enter', { ctrl: true }), true)).toBe('form.complete');
  expect(matchHotkey(key('Enter', 'Enter', { meta: true }), true)).toBe('form.complete');
  expect(matchHotkey(key('Enter', 'Enter', { ctrl: true, shift: true }), true)).toBe('reply.sendNext');
  expect(matchHotkey(key('k', 'KeyK', { ctrl: true }), true)).toBe('palette.open');
  expect(matchHotkey(key('л', 'KeyK', { ctrl: true }), true)).toBe('palette.open');
  // Буква с Shift или Alt: не наша клавиша.
  expect(matchHotkey(key('R', 'KeyR', { shift: true }), false)).toBeNull();
  expect(matchHotkey(key('a', 'KeyA', { alt: true }), false)).toBe('record.add');
});

test('F8 и F9 ничего не делают', () => {
  expect(matchHotkey(key('F8', 'F8'), false)).toBeNull();
  expect(matchHotkey(key('F9', 'F9'), false)).toBeNull();
  expect(matchHotkey(key('F2', 'F2'), false)).toBe('palette.open');
});
