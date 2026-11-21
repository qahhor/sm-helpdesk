import { expect, test } from 'vitest';
import { loadRecent, pushRecent, recentKey } from '@/ui/recent';

// Недавние значения поля на устройстве (решение 14 плана M2): последние выбранные модули сверху списка.

class MemoryStore {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

test('последнее выбранное первым, без повторов, не больше пяти', () => {
  const store = new MemoryStore();
  const key = recentKey('user-1', 'module');
  for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) pushRecent(store, key, id);
  expect(loadRecent(store, key)).toEqual(['f', 'e', 'd', 'a', 'c']);
});

test('у каждого пользователя свои недавние, пустое значение не запоминается', () => {
  const store = new MemoryStore();
  pushRecent(store, recentKey('user-1', 'module'), 'a');
  pushRecent(store, recentKey('user-1', 'module'), '');
  expect(loadRecent(store, recentKey('user-1', 'module'))).toEqual(['a']);
  expect(loadRecent(store, recentKey('user-2', 'module'))).toEqual([]);
});

test('испорченная запись и недоступное хранилище дают пустой список и не ломают форму', () => {
  const store = new MemoryStore();
  const key = recentKey('user-1', 'module');
  store.setItem(key, '{не json');
  expect(loadRecent(store, key)).toEqual([]);
  store.setItem(key, JSON.stringify(['a', 7, null, 'b']));
  expect(loadRecent(store, key)).toEqual(['a', 'b']);
  const broken = {
    getItem: () => {
      throw new Error('нет доступа');
    },
    setItem: () => {
      throw new Error('нет места');
    },
    removeItem: () => {},
  };
  expect(loadRecent(broken, key)).toEqual([]);
  expect(() => pushRecent(broken, key, 'a')).not.toThrow();
  expect(loadRecent(null, key)).toEqual([]);
});
