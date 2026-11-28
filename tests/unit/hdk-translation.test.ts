import { expect, test } from 'vitest';
import type { SolutionDoc } from '@/modules/hdk/doc-schema';
import { applySegments, changedBlockIds, compareInvariants, textSegments } from '@/modules/hdk/translation';

// Перевод по блокам и сверка с оригиналом (план M5, задача 6, решение 9; поправка 101).

const p = (id: string, ...content: object[]) => ({ type: 'paragraph', attrs: { id }, content });
const t = (text: string, href?: string) => ({ type: 'text', text, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) });
const step = (id: string, text: string) => ({ type: 'step', attrs: { id }, content: [p(`${id}p`, t(text))] });
const doc = (...blocks: object[]) => ({ version: 1, blocks }) as unknown as SolutionDoc;

const ORIGINAL = doc(
  { type: 'heading', attrs: { id: 'h000000001', level: 2 }, content: [t('Что видит пользователь')] },
  p('p000000001', t('Ошибка 504 при отчёте за 2026 год. Откройте '), t('документацию', 'https://docs.smartup.uz/a'), t(' и нажмите «Обновить».')),
  step('s000000001', 'Откройте раздел «Склад»'),
  step('s000000002', 'Нажмите «Провести»'),
);

test('куски текста: текстовые узлы абзацев и заголовков, в том числе внутри шагов', () => {
  expect(textSegments(ORIGINAL).map((s) => s.id)).toEqual(['h000000001.0', 'p000000001.0', 'p000000001.1', 'p000000001.2', 's000000001p.0', 's000000002p.0']);
});

test('перевод ложится в копию оригинала: адрес ссылки и устройство из оригинала, неполный ответ не принимается', () => {
  const map = new Map(textSegments(ORIGINAL).map((s) => [s.id, `EN ${s.text}`]));
  map.set('p000000001.1', 'documentation');
  const out = applySegments(ORIGINAL, map)!;
  expect(out.blocks).toHaveLength(4);
  expect(JSON.stringify(out)).toContain('"href":"https://docs.smartup.uz/a"');
  expect(JSON.stringify(out)).toContain('"text":"documentation"');
  expect(JSON.stringify(ORIGINAL)).not.toContain('EN ');
  map.delete('s000000002p.0');
  expect(applySegments(ORIGINAL, map)).toBeNull();
});

test('сверка: тот же перевод без расхождений; лишняя ссылка, телефон, другое число шагов и кавычек находятся', () => {
  const same = applySegments(ORIGINAL, new Map(textSegments(ORIGINAL).map((s) => [s.id, s.text.replace('Откройте', 'Open')])))!;
  expect(compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: same })).toEqual([]);

  const extraLink = applySegments(ORIGINAL, new Map(textSegments(ORIGINAL).map((s) => [s.id, s.id === 's000000002p.0' ? 'Click "Post" at https://evil.example/x' : s.text])))!;
  expect(compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: extraLink }).map((i) => i.kind)).toEqual(['links']);

  const phone = applySegments(ORIGINAL, new Map(textSegments(ORIGINAL).map((s) => [s.id, s.id === 's000000001p.0' ? 'Call +998 90 123 45 67 «Склад»' : s.text])))!;
  const issues = compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: phone });
  // Телефон это и новое число, и находка FR-SOL-04, которой нет в оригинале (0057, M2s).
  expect(issues.map((i) => i.kind)).toEqual(['numbers', 'data']);
  expect(issues[0]!.translation).toContain('998');

  const fewer = doc(...(ORIGINAL.blocks.slice(0, 3) as object[]));
  expect(compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: fewer }).map((i) => i.kind)).toEqual(['quotes', 'steps']);
});

test('изменившиеся блоки оригинала по идентификаторам', () => {
  const next = structuredClone(ORIGINAL) as unknown as { blocks: { content: { text: string }[] }[] };
  next.blocks[1]!.content[0]!.text = 'Ошибка 502';
  const added = doc(...(next.blocks as object[]), step('s000000003', 'Новый шаг'));
  expect(changedBlockIds(ORIGINAL, added)).toEqual(['p000000001', 's000000003']);
});

// Повторная проверка M5 (docs/decisions/0057).
test('M1s: невидимые знаки из перевода модели не попадают в документ', () => {
  const tags = [...'evil'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  const zwj = String.fromCodePoint(0x200d);
  const out = applySegments(ORIGINAL, new Map(textSegments(ORIGINAL).map((s) => [s.id, `EN${tags} ${s.text}${zwj}`])))!;
  expect(JSON.stringify(out)).not.toMatch(/[\u{E0000}-\u{E007F}‍]/u);
  expect(JSON.stringify(out)).toContain('EN Откройте раздел «Склад»');
});

test('M2s: голый домен и адрес почты в переводе, которых нет в оригинале, дают расхождение', () => {
  const swap = (id: string, text: string) => applySegments(ORIGINAL, new Map(textSegments(ORIGINAL).map((s) => [s.id, s.id === id ? text : s.text])))!;
  const domain = compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: swap('s000000001p.0', 'откройте evil-smartup.com «Склад»') });
  expect(domain.map((i) => i.kind)).toContain('links');
  expect(domain.find((i) => i.kind === 'links')!.translation).toContain('evil-smartup.com');
  const email = compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: swap('s000000001p.0', 'напишите help@evil.example «Склад»') });
  expect(email.map((i) => i.kind)).toContain('links');
  // Находка FR-SOL-04, которой нет в оригинале (внутреннее имя), тоже расхождение.
  const internal = compareInvariants({ title: 'Отчёт', doc: ORIGINAL }, { title: 'Report', doc: swap('s000000001p.0', 'вызовите Mkr_Api.Save_Order «Склад»') });
  expect(internal.map((i) => i.kind)).toEqual(['data']);
  expect(internal[0]!.translation).toEqual(['Mkr_Api.Save_Order']);
});

test('M4m: числа с разделителями разрядов равны числу без них, числа, переставленные между шагами, находятся', () => {
  const orig = doc(p('p000000001', t('Лимит 1000 строк')), step('s000000001', 'Введите 5'), step('s000000002', 'Введите 7'));
  const grouped = doc(p('p000000001', t('Limit 1 000 rows')), step('s000000001', 'Enter 5'), step('s000000002', 'Enter 7'));
  const comma = doc(p('p000000001', t('Limit 1,000 rows')), step('s000000001', 'Enter 5'), step('s000000002', 'Enter 7'));
  expect(compareInvariants({ title: 'A', doc: orig }, { title: 'A', doc: grouped })).toEqual([]);
  expect(compareInvariants({ title: 'A', doc: orig }, { title: 'A', doc: comma })).toEqual([]);
  const swapped = doc(p('p000000001', t('Limit 1000 rows')), step('s000000001', 'Enter 7'), step('s000000002', 'Enter 5'));
  expect(compareInvariants({ title: 'A', doc: orig }, { title: 'A', doc: swapped }).map((i) => i.kind)).toEqual(['numbers']);
});

// Сверка простого текста (план M7, задача 4, решение 11): заголовок и описание идеи без разметки.
const IDEA = { title: 'Печать 50 накладных за раз', body: 'Кнопка «Печать» на экране «Накладные».\nСейчас печатаем по одной, 200 в день.' };

test('простой текст: верный перевод без расхождений', async () => {
  const { comparePlainInvariants } = await import('@/modules/hdk/translation');
  expect(comparePlainInvariants(IDEA, { title: 'Print 50 invoices at once', body: 'The «Print» button on the «Invoices» screen.\nNow we print one by one, 200 a day.' })).toEqual([]);
});

test('простой текст: потерянное число, лишний телефон, ссылка и кавычки дают расхождения', async () => {
  const { comparePlainInvariants } = await import('@/modules/hdk/translation');
  const kinds = (title: string, body: string) => comparePlainInvariants(IDEA, { title, body }).map((issue) => issue.kind);
  expect(kinds('Print invoices at once', 'The «Print» button on the «Invoices» screen. Now one by one, 200 a day.')).toEqual(['numbers']);
  expect(kinds('Print 50 invoices at once', 'The «Print» button on the «Invoices» screen. Call +998 90 123 45 67, 200 a day.')).toEqual(expect.arrayContaining(['data']));
  expect(kinds('Print 50 invoices at once', 'The «Print» button on the «Invoices» screen. See https://evil.example, 200 a day.')).toEqual(['links']);
  expect(kinds('Print 50 invoices at once', 'The Print button on the Invoices screen. Now one by one, 200 a day.')).toEqual(['quotes']);
});

// Проверка на AI-инъекции (волна 7, S-I3): перевод текста клиента, который увидят другие организации без человека.
test('текст клиента: перевод вдвое длиннее или вдвое короче оригинала, адрес словами и новые слова адреса дают расхождения', async () => {
  const { compareClientTextInvariants } = await import('@/modules/hdk/translation');
  const kinds = (title: string, body: string) => compareClientTextInvariants(IDEA, { title, body }).map((issue) => issue.kind);
  const good = 'The «Print» button on the «Invoices» screen.\nNow we print one by one, 200 a day.';
  expect(kinds('Print 50 invoices at once', good)).toEqual([]);
  // Дописанное указание: длина больше двух длин оригинала.
  expect(kinds('Print 50 invoices at once', `${good} ${'Important notice for all clients: your account is blocked, contact the support team. '.repeat(3)}`)).toEqual(['length']);
  expect(kinds('Print 50', '«P» «I» 200')).toEqual(['length']);
  // Адрес словами на трёх языках: домена в тексте нет, сверка ссылок его не видит.
  for (const spelled of ['write to evil dot com', 'пишите на evil точка ком', 'evil nuqta uz ga yozing', 'support собака evil точка com', 'evil (dot) com'])
    expect(kinds('Print 50 invoices at once', `${good} ${spelled}`), spelled).toContain('spelled_address');
  // Новые слова адреса без самого адреса.
  for (const word of ['open https evil', 'go to www evil', 'telegram: evil_support', 'в телеграм evil_support'])
    expect(kinds('Print 50 invoices at once', `${good} ${word}`), word).toContain('address_words');
  // Слово "точка" в обычном смысле расхождением не считается, и слово, которое было в оригинале, тоже.
  expect(compareClientTextInvariants({ title: 'Торговая точка закрыта', body: 'Каждая точка продаж шлёт отчёт в телеграм' }, { title: 'Savdo nuqtasi yopiq', body: 'Har bir savdo nuqtasi hisobotni telegram orqali yuboradi' })).toEqual([]);
  expect(compareClientTextInvariants({ title: 'Outlet is closed', body: 'Every point of sale sends a report' }, { title: 'Торговая точка закрыта', body: 'Каждая точка продаж шлёт отчёт' })).toEqual([]);
});
