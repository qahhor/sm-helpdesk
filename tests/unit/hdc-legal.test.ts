import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { getPolicy, getPolicyVersion, parsePolicy } from '@/modules/hdc/legal';

// Политика обработки данных из файлов content/legal/ (раздел 14.6 ТЗ, решение 0017).

const dir = () => mkdtempSync(join(tmpdir(), 'legal-'));

test('текст политики разбирается на заголовки, абзацы и пункты, разметка остаётся текстом', () => {
  expect(
    parsePolicy(
      '# Политика\n\nПервый абзац\nпродолжение.\n\n## Что храним\n- имя\n- email\n\n<script>alert(1)</script> [ссылка](https://evil.example)',
    ),
  ).toEqual([
    { kind: 'h1', text: 'Политика' },
    { kind: 'p', text: 'Первый абзац продолжение.' },
    { kind: 'h2', text: 'Что храним' },
    { kind: 'li', text: 'имя' },
    { kind: 'li', text: 'email' },
    { kind: 'p', text: '<script>alert(1)</script> [ссылка](https://evil.example)' },
  ]);
  expect(parsePolicy('')).toEqual([]);
  expect(parsePolicy('\r\n# Заголовок\r\nабзац\r\n')).toEqual([
    { kind: 'h1', text: 'Заголовок' },
    { kind: 'p', text: 'абзац' },
  ]);
});

test('без файла manifest политика выключена, без перевода берётся русский текст', async () => {
  const empty = dir();
  expect(await getPolicy('ru', empty)).toBeNull();
  expect(await getPolicyVersion(empty)).toBeNull();
  writeFileSync(join(empty, 'manifest.json'), JSON.stringify({ privacy: { version: '2026-12-01' } }));
  writeFileSync(join(empty, 'privacy.ru.md'), '# Политика');
  expect(await getPolicyVersion(empty)).toBe('2026-12-01');
  expect(await getPolicy('uz', empty)).toEqual({ version: '2026-12-01', locale: 'ru', blocks: [{ kind: 'h1', text: 'Политика' }] });
  writeFileSync(join(empty, 'privacy.uz.md'), '# Siyosat');
  expect(await getPolicy('uz', empty)).toMatchObject({ locale: 'uz', blocks: [{ kind: 'h1', text: 'Siyosat' }] });
});

test('испорченный manifest или нет русского текста: политика выключена', async () => {
  const broken = dir();
  writeFileSync(join(broken, 'manifest.json'), '{ не json');
  expect(await getPolicyVersion(broken)).toBeNull();
  writeFileSync(join(broken, 'manifest.json'), JSON.stringify({ privacy: { version: '../x' } }));
  expect(await getPolicyVersion(broken)).toBeNull();
  writeFileSync(join(broken, 'manifest.json'), JSON.stringify({ privacy: { version: '2026-12-01' } }));
  expect(await getPolicy('en', broken)).toBeNull();
});

test('имя файла политики не строится из чужого ввода', async () => {
  const legal = dir();
  writeFileSync(join(legal, 'manifest.json'), JSON.stringify({ privacy: { version: '2026-12-01' } }));
  writeFileSync(join(legal, 'privacy.ru.md'), '# Политика');
  await expect(getPolicy('../../etc/passwd' as never, legal)).resolves.toMatchObject({ locale: 'ru' });
  await expect(getPolicy('../../etc/passwd' as never, dir())).resolves.toBeNull();
});
