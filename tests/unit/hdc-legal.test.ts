import { mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

test('версия политики не перечитывается, пока файл не изменился (проверка main, Q13)', async () => {
  const legal = dir();
  const manifest = join(legal, 'manifest.json');
  // Время изменения в целых секундах: его можно вернуть файлу точно.
  const at = new Date('2026-11-01T10:00:00Z');
  writeFileSync(manifest, JSON.stringify({ privacy: { version: '2026-12-01' } }));
  utimesSync(manifest, at, at);
  expect(await getPolicyVersion(legal)).toBe('2026-12-01');
  // Другое содержимое той же длины с прежним временем изменения: файл не читается заново.
  writeFileSync(manifest, JSON.stringify({ privacy: { version: '2026-12-02' } }));
  utimesSync(manifest, at, at);
  expect(statSync(manifest).mtime.getTime()).toBe(at.getTime());
  expect(await getPolicyVersion(legal)).toBe('2026-12-01');
  // Новое время изменения: новая версия.
  const later = new Date(at.getTime() + 5000);
  utimesSync(manifest, later, later);
  expect(await getPolicyVersion(legal)).toBe('2026-12-02');
});
