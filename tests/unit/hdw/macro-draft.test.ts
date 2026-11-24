import { expect, test } from 'vitest';
import { draftWithTemplate, MACRO_DRAFT_MAX } from '@/modules/hdw/macro-draft';

// Шаблон макроса и черновик сотрудника (проверка вехи M8, находка I3): шаблон ответа клиенту не вставляется в
// черновик внутренней заметки и не превращает её в публичный ответ.

test('пустой черновик или его нет: шаблон становится черновиком публичного ответа', () => {
  expect(draftWithTemplate(null, 'Пришлите версию')).toEqual({ body: 'Пришлите версию', internal: false });
  expect(draftWithTemplate({ body: '', internal: false }, 'Пришлите версию')).toEqual({ body: 'Пришлите версию', internal: false });
});

test('черновик публичного ответа: шаблон дописывается после него через пустую строку', () => {
  expect(draftWithTemplate({ body: 'Здравствуйте!', internal: false }, 'Пришлите версию')).toEqual({ body: 'Здравствуйте!\n\nПришлите версию', internal: false });
});

test('непустой черновик внутренней заметки: шаблон не вставляется, черновик остаётся как есть', () => {
  expect(draftWithTemplate({ body: 'Клиент должен за два месяца', internal: true }, 'Пришлите версию')).toBeNull();
});

test('пустой черновик в режиме заметки терять нечего: шаблон вставляется как публичный ответ', () => {
  expect(draftWithTemplate({ body: '  \n', internal: true }, 'Пришлите версию')).toEqual({ body: 'Пришлите версию', internal: false });
});

test('черновик с шаблоном не длиннее предела сообщения', () => {
  const merged = draftWithTemplate({ body: 'а'.repeat(MACRO_DRAFT_MAX - 5), internal: false }, 'Пришлите версию');
  expect(merged?.body).toHaveLength(MACRO_DRAFT_MAX);
});
