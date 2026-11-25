import { describe, expect, test } from 'vitest';
import { HANDOFF_TTL_MS, handoffDescription, parseWidgetFragment, stashWidgetHandoff, takeWidgetHandoff } from '@/ui/widget/handoff';

// Режим B виджета (план M6, задача 8; решения 11 и 12): загрузчик открывает /{язык}/tickets/new#widget=1&hints=...
// Подсказки живут только во фрагменте и в sessionStorage вкладки портала, на сервер в адресе не уходят.

const hints = { module: 'orders', form: 'order_edit', appVersion: '5.12.0', errorCode: 'ORA-20001', errorText: 'Нет доступа к складу' };
const fragment = (value: unknown) => `#widget=1&hints=${encodeURIComponent(JSON.stringify(value))}`;

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

describe('разбор фрагмента', () => {
  test('признак виджета и подсказки по решению 11', () => {
    expect(parseWidgetFragment(fragment(hints))).toEqual({ hints });
    // Без подсказок признак виджета всё равно есть: обращение считается виджетом.
    expect(parseWidgetFragment('#widget=1')).toEqual({ hints: {} });
  });

  test('неверная подсказка отбрасывается, остальные остаются', () => {
    const parsed = parseWidgetFragment(fragment({ ...hints, module: 'orders<script>', errorText: 'x'.repeat(2001), extra: 'nope' }));
    expect(parsed).toEqual({ hints: { form: 'order_edit', appVersion: '5.12.0', errorCode: 'ORA-20001' } });
    expect(parseWidgetFragment('#widget=1&hints=%7Bnot-json')).toEqual({ hints: {} });
    expect(parseWidgetFragment(`#widget=1&hints=${encodeURIComponent('[1,2]')}`)).toEqual({ hints: {} });
  });

  test('без признака виджета фрагмент не трогается', () => {
    expect(parseWidgetFragment('')).toBeNull();
    expect(parseWidgetFragment('#ctx=abc')).toBeNull();
    expect(parseWidgetFragment(`#widget=0&hints=${encodeURIComponent(JSON.stringify(hints))}`)).toBeNull();
    expect(parseWidgetFragment('#top')).toBeNull();
  });
});

describe('передача через вход', () => {
  const now = new Date('2026-11-25T10:00:00Z');

  test('сохранённое на странице входа забирается формой один раз', () => {
    const storage = memory();
    expect(stashWidgetHandoff(storage, fragment(hints), now)).toBe(true);
    expect(takeWidgetHandoff(storage, new Date(now.getTime() + 60_000))).toEqual({ hints });
    expect(takeWidgetHandoff(storage, now)).toBeNull();
  });

  test('старше 30 минут не подставляется', () => {
    const storage = memory();
    stashWidgetHandoff(storage, fragment(hints), now);
    expect(takeWidgetHandoff(storage, new Date(now.getTime() + HANDOFF_TTL_MS + 1))).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  test('чужой фрагмент не сохраняется, испорченная запись и хранилище без доступа не ломают форму', () => {
    const storage = memory();
    expect(stashWidgetHandoff(storage, '#ctx=abc', now)).toBe(false);
    expect(storage.data.size).toBe(0);
    storage.setItem('hub.widget-handoff', '{broken');
    expect(takeWidgetHandoff(storage, now)).toBeNull();
    expect(takeWidgetHandoff(null, now)).toBeNull();
    expect(stashWidgetHandoff(null, fragment(hints), now)).toBe(false);
  });
});

test('описание из ошибки: код и текст, без кода только текст', () => {
  expect(handoffDescription(hints)).toBe('ORA-20001: Нет доступа к складу');
  expect(handoffDescription({ errorText: 'Нет доступа' })).toBe('Нет доступа');
  expect(handoffDescription({ errorCode: 'E1' })).toBe('E1');
  expect(handoffDescription({ module: 'orders' })).toBe('');
});
