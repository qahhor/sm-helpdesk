import { expect, test } from 'vitest';
import { agentExcerpt, anonymizeForAgent, aliasFor, emptyAliases } from '@/modules/hda/agent/anonymize';
import attacks from '../fixtures/agent/attacks.json';

// Обезличивание текста для AI-сотрудника (веха M8b, задача 2; FR-AGT-06, FR-AGT-15, T27; план M8b, решение 8).

const people = [
  { id: 'c1', name: 'Тимур Каримов', kind: 'client' as const },
  { id: 'c2', name: 'Dilnoza Rashidova', kind: 'client' as const },
  { id: 's1', name: 'Алишер Усманов', kind: 'staff' as const },
];
const known = { people, orgTerms: ['ООО "Ромашка"', '302456789'] };
const run = (text: string) => anonymizeForAgent(text, known).text;

test('почта и телефоны в форматах Узбекистана и России заменяются', () => {
  expect(run('Пишите на timur@romashka.uz или ivan @ mail.ru')).toBe('Пишите на [email] или [email]');
  expect(run('Звоните +998 90 123 45 67')).toBe('Звоните [телефон]');
  expect(run('Звоните 998901234567')).toBe('Звоните [телефон]');
  expect(run('Звоните +998(90)123-45-67')).toBe('Звоните [телефон]');
  expect(run('Звоните 8 (916) 555-12-34')).toBe('Звоните [телефон]');
  expect(run('Звоните +7 916 555 12 34')).toBe('Звоните [телефон]');
});

test('ИНН, ПИНФЛ и длинные числа заменяются меткой номера', () => {
  expect(run('ИНН 305123456')).toBe('ИНН [номер]');
  expect(run('ПИНФЛ 31503861220011')).toBe('ПИНФЛ [номер]');
});

test('имена людей заменяются устойчивыми обозначениями в разных падежах и регистре', () => {
  const result = anonymizeForAgent('Тимур Каримов написал. Позвоните Каримову, тимур ждёт. Ответил Алишер Усманов, потом Dilnoza Rashidovaning hamkasbi.', known);
  expect(result.text).toBe('Клиент 1 написал. Позвоните Клиент 1, Клиент 1 ждёт. Ответил Сотрудник 1, потом Клиент 2 hamkasbi.');
  // Тот же человек в следующем тексте того же ответа получает то же обозначение.
  const next = anonymizeForAgent('Dilnoza и Тимур', known, result.aliases);
  expect(next.text).toBe('Клиент 2 и Клиент 1');
});

test('обозначение автора сообщения устойчиво в пределах ответа', () => {
  let aliases = emptyAliases();
  const first = aliasFor(aliases, 'c9', 'client');
  aliases = first.aliases;
  const staff = aliasFor(aliases, 's9', 'staff');
  aliases = staff.aliases;
  expect(first.alias).toBe('Клиент 1');
  expect(staff.alias).toBe('Сотрудник 1');
  expect(aliasFor(aliases, 'c9', 'client').alias).toBe('Клиент 1');
  expect(aliasFor(aliases, 'c10', 'client').alias).toBe('Клиент 2');
});

test('название организации в кавычках и без и её ИНН заменяются', () => {
  expect(run('Клиент из ООО "Ромашка" и «Ромашке» снова пишет')).toBe('Клиент из [организация] и «[организация]» снова пишет');
  expect(run('Ромашка, ИНН 302456789')).toBe('[организация], ИНН [организация]');
});

test('сервер клиента Smartup не отдаётся, открытые адреса Smartup остаются', () => {
  expect(run('Ошибка на acme7.smartup.uz при входе')).toBe('Ошибка на [сервер] при входе');
  expect(run('См. help.smartup.uz')).toBe('См. help.smartup.uz');
});

test('невидимые знаки на трёх языках удаляются, данные за ними находятся', () => {
  expect(run('Ош​ибка⁠ при проведении')).toBe('Ошибка при проведении');
  expect(run('Xa​tolik yuz berdi')).toBe('Xatolik yuz berdi');
  expect(run('Er­ror‍ occurred')).toBe('Error occurred');
  expect(run('t​i​m@romashka.uz')).toBe('[email]');
});

test('обычный текст ошибки, номера версий, даты и коды не портятся', () => {
  for (const text of [
    'ORA-06512: at "MKR_API.SAVE_ORDER", line 42',
    'Версия 8.15.6, сборка 2.4.0',
    'Обновили 25.11.2026 в 10:30, ошибка 500 на странице заказа',
    'Накладная №145 не проводится, сумма 1 250 000',
    'Hisob-faktura 12 ta pozitsiya bilan saqlanmadi',
  ])
    expect(run(text), text).toBe(text);
});

test('набор атак после обезличивания не содержит контактов', () => {
  for (const text of attacks.cases) {
    const out = anonymizeForAgent(text, { people: attacks.people as typeof people, orgTerms: attacks.orgTerms }).text;
    for (const contact of attacks.contacts) expect(out.toLowerCase(), `${text} -> ${out}`).not.toContain(contact.toLowerCase());
    expect(out, text).not.toMatch(/[​-‏⁠-⁤﻿]/u);
  }
});

test('выдержка: не длиннее предела, по границе слова', () => {
  const text = 'слово '.repeat(100);
  const excerpt = agentExcerpt(text, 300);
  expect(excerpt.length).toBeLessThanOrEqual(301);
  expect(excerpt.endsWith('…')).toBe(true);
  expect(agentExcerpt('Короткий текст')).toBe('Короткий текст');
});
