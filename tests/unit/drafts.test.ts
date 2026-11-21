import { expect, test } from 'vitest';
import { clearDraft, draftKey, loadDraft, saveDraft } from '@/ui/drafts';

// Черновик обращения и ответа на устройстве (UX-C-02, FR-TK-16, решение 0026 пункт 8).

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

test('черновик по ключу пользователя восстанавливается и очищается после отправки', () => {
  const store = new MemoryStore();
  const key = draftKey('user-1', 'new-ticket');
  saveDraft(store, key, { description: 'Не грузится отчёт', title: '' });
  expect(loadDraft(store, key)).toEqual({ description: 'Не грузится отчёт', title: '' });
  clearDraft(store, key);
  expect(loadDraft(store, key)).toBeNull();
});

test('чужой черновик не виден: ключ включает пользователя и место', () => {
  const store = new MemoryStore();
  saveDraft(store, draftKey('user-1', 'new-ticket'), { description: 'мой' });
  expect(loadDraft(store, draftKey('user-2', 'new-ticket'))).toBeNull();
  expect(loadDraft(store, draftKey('user-1', 'reply-1042'))).toBeNull();
  expect(draftKey('user-1', 'reply-1042')).not.toBe(draftKey('user-1', 'new-ticket'));
});

test('пустой черновик не хранится, испорченный и недоступное хранилище не ломают форму', () => {
  const store = new MemoryStore();
  const key = draftKey('user-1', 'new-ticket');
  saveDraft(store, key, { description: '  ', title: '' });
  expect(store.data.size).toBe(0);
  store.setItem(key, '{не json');
  expect(loadDraft(store, key)).toBeNull();
  store.setItem(key, JSON.stringify(['не объект']));
  expect(loadDraft(store, key)).toBeNull();
  const broken = {
    getItem: () => {
      throw new Error('нет доступа');
    },
    setItem: () => {
      throw new Error('нет места');
    },
    removeItem: () => {
      throw new Error('нет доступа');
    },
  };
  expect(loadDraft(broken, key)).toBeNull();
  expect(() => saveDraft(broken, key, { description: 'текст' })).not.toThrow();
  expect(() => clearDraft(broken, key)).not.toThrow();
  expect(loadDraft(null, key)).toBeNull();
});
