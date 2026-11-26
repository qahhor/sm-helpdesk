import { expect, test } from 'vitest';
import { GUIDE_FILES, guideProblems, guidesCheck, quotedLabels } from '../../../scripts/checks/guides.mjs';

// Инструкции сотрудника и клиента (план подготовки M9, задача 7, решения 10 и 11): каждое название кнопки в «...»
// есть в messages/<язык>.json, нет слов, запрещённых разделом 8.13 ТЗ, и обещаний "точно" и "гарантированно";
// узбекская инструкция помечена черновиком до вычитки носителем языка.

const MESSAGES = {
  ru: { client: { send: 'Отправить обращение', nav: { ideas: 'Идеи' } }, agent: { take: 'Взять в работу' } },
  uz: { client: { send: "Murojaatni yuborish" } },
  en: { client: { send: 'Send request' } },
};

test('названия в «...» читаются из текста', () => {
  expect(quotedLabels('Нажмите «Отправить обращение», затем «Идеи».')).toEqual(['Отправить обращение', 'Идеи']);
});

test('название, которого нет в интерфейсе этого языка, называется с номером строки', () => {
  expect(guideProblems('docs/guides/client.ru.md', 'Строка\nНажмите «Отправить заявку».', MESSAGES)).toEqual([
    'docs/guides/client.ru.md:2 «Отправить заявку» нет в messages/ru.json',
    'docs/guides/client.ru.md:2 запрещённое слово заявк',
  ]);
  expect(guideProblems('docs/guides/client.ru.md', 'Нажмите «Отправить обращение».', MESSAGES)).toEqual([]);
  // Название из другого языка не засчитывается.
  expect(guideProblems('docs/guides/client.en.md', 'Press «Отправить обращение».', MESSAGES)).toEqual([
    'docs/guides/client.en.md:1 «Отправить обращение» нет в messages/en.json',
  ]);
});

test('обещания и слова для клиента: точно, гарантированно, SLA, ticket', () => {
  expect(guideProblems('docs/guides/client.ru.md', 'Мы точно ответим, это гарантированно.', MESSAGES)).toEqual([
    'docs/guides/client.ru.md:1 запрещённое слово гарантированн',
    'docs/guides/client.ru.md:1 запрещённое слово точно',
  ]);
  expect(guideProblems('docs/guides/client.en.md', 'Open a ticket. We guarantee it.', MESSAGES)).toEqual([
    'docs/guides/client.en.md:1 запрещённое слово guarantee',
    'docs/guides/client.en.md:1 запрещённое слово ticket',
  ]);
  // Слова рабочего места в инструкции сотрудника допустимы ("очередь"), обещания нет.
  expect(guideProblems('docs/guides/staff.ru.md', 'Откройте очередь и нажмите «Взять в работу».', MESSAGES)).toEqual([]);
});

test('узбекская инструкция без пометки черновика не проходит', () => {
  expect(guideProblems('docs/guides/client.uz.md', '# Qo\'llanma\n\nTekst «Murojaatni yuborish».', MESSAGES)).toEqual([
    'docs/guides/client.uz.md:1 нет пометки "Qoralama" (черновик до вычитки носителем языка, решение 11)',
  ]);
  expect(guideProblems('docs/guides/client.uz.md', "> **Qoralama.** Ona tili egasi tekshiradi.\n\nTekst «Murojaatni yuborish».", MESSAGES)).toEqual([]);
});

test('настоящие инструкции: все шесть файлов есть и проходят проверку', () => {
  expect(GUIDE_FILES).toHaveLength(6);
  expect(guidesCheck()).toEqual([]);
});
