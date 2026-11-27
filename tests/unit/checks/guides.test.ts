import { expect, test } from 'vitest';
import { GUIDE_FILES, guideProblems, guidesCheck, LEGAL_FILES, legalProblems, quotedLabels } from '../../../scripts/checks/guides.mjs';

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

// --- Черновики юридических текстов docs/legal (план M9, задача 11, решение 19) ---

const POLICY = [
  '> Черновик для юриста. В портале не показывается.',
  '',
  '# Политика',
  '',
  '## Кому передаются данные',
  '',
  '- Hetzner: размещение.',
  '- Cloudflare: сеть.',
  '- Resend: письма.',
  '- Telegram: уведомления, тема до 60 знаков.',
  '- Anthropic: тексты обращений.',
  '- Hermes Agent через Anthropic и OpenAI: обезличенные тексты.',
  '',
  '## Сколько хранятся данные',
].join('\n');

test('черновик политики с пометкой и перечнем субобработчиков 14.6 проходит', () => {
  expect(LEGAL_FILES).toEqual([
    'docs/legal/privacy-draft.ru.md',
    'docs/legal/privacy-draft.uz.md',
    'docs/legal/privacy-draft.en.md',
    'docs/legal/ai-consent-draft.ru.md',
    'docs/legal/ai-consent-draft.uz.md',
    'docs/legal/ai-consent-draft.en.md',
  ]);
  expect(legalProblems('docs/legal/privacy-draft.ru.md', POLICY)).toEqual([]);
});

test('без строки "Черновик для юриста" в начале: ошибка', () => {
  expect(legalProblems('docs/legal/ai-consent-draft.en.md', '# Consent\n\nText.')).toEqual(['docs/legal/ai-consent-draft.en.md:1 нет пометки "Черновик для юриста" в первой строке']);
});

test('субобработчик не из 14.6 и пропущенный субобработчик: ошибка', () => {
  const extra = POLICY.replace('- Resend: письма.', '- Resend: письма.\n- Mailgun: письма.');
  expect(legalProblems('docs/legal/privacy-draft.ru.md', extra)).toEqual(['docs/legal/privacy-draft.ru.md: субобработчик Mailgun не назван в разделе 14.6 ТЗ']);
  const missing = POLICY.replace('- Cloudflare: сеть.\n', '');
  expect(legalProblems('docs/legal/privacy-draft.ru.md', missing)).toEqual(['docs/legal/privacy-draft.ru.md: нет субобработчика Cloudflare из раздела 14.6 ТЗ']);
  expect(legalProblems('docs/legal/privacy-draft.ru.md', POLICY.replace('## Кому передаются данные', '## Партнёры'))).toEqual(['docs/legal/privacy-draft.ru.md: нет раздела о субобработчиках']);
});

test('запрещённые слова и обещания в юридическом тексте: ошибка с номером строки', () => {
  expect(legalProblems('docs/legal/privacy-draft.en.md', '> Черновик для юриста.\n\n## Who receives the data\n\n- Hetzner: hosting.\n\nWe guarantee your ticket is safe.')).toEqual(
    expect.arrayContaining(['docs/legal/privacy-draft.en.md:7 запрещённое слово guarantee', 'docs/legal/privacy-draft.en.md:7 запрещённое слово ticket']),
  );
});

test('настоящие черновики docs/legal проходят проверку', () => {
  expect(guidesCheck().filter((p) => p.startsWith('docs/legal/'))).toEqual([]);
});
