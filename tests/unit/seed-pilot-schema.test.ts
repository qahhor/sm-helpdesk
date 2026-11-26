import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  parseSeedFile,
  SEED_AUDIENCES,
  SEED_LOCALES,
  SEED_STAFF_ROLES,
  SEED_TAG_COLORS,
  SEED_TICKET_TYPES,
  SEED_VOTE_MODES,
} from '@/cli/seed-pilot-schema';
import { LOCALES } from '@/i18n/locales';
import { VOTE_MODES } from '@/modules/hdi/pref';
import { KB_AUDIENCES } from '@/modules/hdk/pref';
import { TAG_COLORS } from '@/modules/hdr/pref';
import { TICKET_TYPES } from '@/modules/hdt/pref';
import { HUMAN_STAFF_ROLES } from '@/modules/hdu/pref';

// Файл начальных данных hub seed:pilot (план подготовки M9, задача 6, решение 9): строгая схема, данных клиентов нет,
// тексты на трёх языках, ошибка называет запись.

const example = () => JSON.parse(readFileSync('docs/pilot/seed.example.json', 'utf8'));
const parse = (value: unknown) => parseSeedFile(JSON.stringify(value));
const problems = (value: unknown) => {
  const result = parse(value);
  return result.ok ? [] : result.problems;
};

test('пример из docs/pilot проходит схему', () => {
  const result = parse(example());
  expect(result.ok).toBe(true);
});

test('перечни схемы совпадают с перечнями модулей', () => {
  expect(SEED_TICKET_TYPES).toEqual(TICKET_TYPES);
  expect(SEED_TAG_COLORS).toEqual(TAG_COLORS);
  expect(SEED_VOTE_MODES).toEqual(VOTE_MODES);
  expect(SEED_STAFF_ROLES).toEqual(HUMAN_STAFF_ROLES);
  expect(SEED_LOCALES).toEqual(LOCALES);
  expect(SEED_AUDIENCES).toEqual(KB_AUDIENCES);
});

test('поле организаций, клиентов или обращений отклоняет файл целиком', () => {
  for (const field of ['organizations', 'tickets', 'clients', 'users']) {
    const found = problems({ ...example(), [field]: [{ name: 'ACME' }] });
    expect(found, field).toEqual([expect.stringContaining(`поле ${field} не допускается`)]);
  }
});

test('неизвестное поле в записи и в корне отклоняется', () => {
  const file = example();
  file.templates[1].orgId = 'x';
  expect(problems(file)).toEqual([expect.stringMatching(/^templates, запись 2 \(rights\): неизвестные поля orgId$/)]);
  expect(problems({ ...example(), extra: 1 })).toEqual([expect.stringContaining('неизвестные поля extra')]);
});

test('тексты шаблонов и названия модулей обязательны на ru, uz и en', () => {
  const file = example();
  delete file.templates[0].body.uz;
  delete file.modules[1].name.en;
  const found = problems(file);
  expect(found).toContainEqual(expect.stringMatching(/^modules, запись 2 \(warehouse\): name\.en/));
  expect(found).toContainEqual(expect.stringMatching(/^templates, запись 1 \(version\): body\.uz/));
});

test('повтор ключа в разделе называет обе записи', () => {
  const file = example();
  file.templates.push({ ...file.templates[0], shortcut: 'VERSION' });
  expect(problems(file)).toEqual(['templates, запись 4 (version): тот же ключ уже в записи 1']);
});

test('документ решения проверяется схемой редактора, даты праздников настоящие', () => {
  const file = example();
  file.solutions[0].doc = { version: 1, blocks: [{ type: 'script', attrs: { id: 'seedex-x1' } }] };
  file.holidays[0].dates.push('2027-02-30');
  const found = problems(file);
  expect(found).toContainEqual(expect.stringMatching(/^solutions, запись 1 \(.+\): doc: документ решения/));
  expect(found).toContainEqual(expect.stringMatching(/^holidays, запись 1 \(2027\): dates\.7: такой даты нет/));
});

test('не JSON и версия файла', () => {
  expect(parseSeedFile('{').ok).toBe(false);
  expect(problems({ ...example(), version: 2 })).toEqual([expect.stringContaining('version')]);
});
