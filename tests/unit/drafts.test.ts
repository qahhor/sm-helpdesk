import { expect, test } from 'vitest';
import { clearDeviceData, clearDraft, clearIfSent, draftKey, forgetSent, loadDraft, rememberSent, saveDraft, sentMatches } from '@/ui/drafts';

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

test('после успешной отправки удаляется только отправленный текст, новый черновик остаётся (FR-TK-16)', () => {
  const local = new MemoryStore();
  const session = new MemoryStore();
  const key = draftKey('user-1', 'new-ticket');
  saveDraft(local, key, { description: 'Отправленный текст' });
  rememberSent(session, key, { description: 'Отправленный текст' });
  expect(sentMatches(local, session, key)).toBe(true);
  expect(clearIfSent(local, session, key)).toBe(true);
  expect(loadDraft(local, key)).toBeNull();
  // Возврат по истории на ту же страницу успеха: отметки отправки уже нет, новый черновик не трогается.
  saveDraft(local, key, { description: 'Новый текст после отправки' });
  expect(sentMatches(local, session, key)).toBe(false);
  expect(clearIfSent(local, session, key)).toBe(false);
  expect(loadDraft(local, key)).toEqual({ description: 'Новый текст после отправки' });
});

test('черновик изменили после отправки или ссылку на страницу успеха открыли в другом браузере: ничего не стирается', () => {
  const local = new MemoryStore();
  const session = new MemoryStore();
  const key = draftKey('user-1', 'reply-1042');
  rememberSent(session, key, { body: 'ответ' });
  saveDraft(local, key, { body: 'ответ и ещё строка' });
  expect(clearIfSent(local, session, key)).toBe(false);
  expect(loadDraft(local, key)).toEqual({ body: 'ответ и ещё строка' });
  // Без отметки отправки (другой браузер, вставленная ссылка) черновик тоже цел.
  const other = new MemoryStore();
  saveDraft(other, key, { body: 'чужой черновик' });
  expect(clearIfSent(other, new MemoryStore(), key)).toBe(false);
  expect(loadDraft(other, key)).toEqual({ body: 'чужой черновик' });
  expect(sentMatches(null, null, key)).toBe(false);
});

test('неудачная отправка снимает отметку: черновик остаётся и после страницы успеха', () => {
  const local = new MemoryStore();
  const session = new MemoryStore();
  const key = draftKey('user-1', 'new-ticket');
  saveDraft(local, key, { description: 'текст' });
  rememberSent(session, key, { description: 'текст' });
  forgetSent(session, key);
  expect(session.data.size).toBe(0);
  expect(clearIfSent(local, session, key)).toBe(false);
  expect(loadDraft(local, key)).toEqual({ description: 'текст' });
  // Порядок полей в объекте на сравнение не влияет.
  saveDraft(local, key, { title: 'a', description: 'b' });
  rememberSent(session, key, { description: 'b', title: 'a' });
  expect(sentMatches(local, session, key)).toBe(true);
});

// ASVS 5.0.0, требование 14.3.1 (план подготовки M9, задача 1): после выхода на устройстве не остаются черновики
// обращений и ответов, недавние модули, копии решений и подсказки виджета. Чужие ключи страницы не трогаются.
test('при выходе удаляются все записи портала в обоих хранилищах браузера', () => {
  class ListStore extends MemoryStore {
    get length() {
      return this.data.size;
    }
    key(index: number) {
      return [...this.data.keys()][index] ?? null;
    }
  }
  const local = new ListStore();
  const session = new ListStore();
  saveDraft(local, draftKey('user-1', 'new-ticket'), { description: 'текст обращения' });
  local.setItem('hub:recent:user-1:module', '["m1"]');
  local.setItem('hub:solution-draft:12:ru', '{}');
  local.setItem('other-site', 'x');
  session.setItem('hub:sent:user-1:new-ticket', '{}');
  session.setItem('hub.widget-handoff', '{}');
  clearDeviceData([local, session, null]);
  expect([...local.data.keys()]).toEqual(['other-site']);
  expect([...session.data.keys()]).toEqual([]);
});
