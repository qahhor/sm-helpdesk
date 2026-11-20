import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('материалы пакета на месте, ТЗ версии 1.1 и запись о ней в истории версий', () => {
  for (const f of [
    'CLAUDE.md',
    'docs/TZ.md',
    'docs/questions.md',
    'docs/CHANGELOG.md',
    'docs/brand/BRAND-GUIDE.md',
    'docs/design/smartup-tokens.scss',
    'docs/design/smartup-breakpoints.scss',
    'docs/brand/logo/smartup-logo-light-bg.png',
    'docs/brand/logo/smartup-logo-dark-bg.png',
    'docs/brand/tez/tez-icon.svg',
    'docs/brand/tez/tez-icon-on-dark.svg',
    'docs/brand/tez/tez-main.svg',
    'docs/brand/tez/tez-main-on-dark.svg',
    'docs/brand/fonts/Montserrat/OFL.txt',
  ])
    expect(existsSync(f), f).toBe(true);
  expect(readFileSync('docs/TZ.md', 'utf8')).toMatch(/^\*\*Версия:\*\* 1\.1$/m);
  expect(readFileSync('docs/CHANGELOG.md', 'utf8')).toMatch(/^## 1\.1 \(/m);
});

test('правила для Claude Code совпадают с разделом 16.1 ТЗ', () => {
  const fence = '`'.repeat(3);
  const block = new RegExp(
    fence + 'markdown\\n(# Smartup Hub - правила для Claude Code[\\s\\S]*?)' + fence,
  ).exec(readFileSync('docs/TZ.md', 'utf8'))?.[1];
  expect(block, 'блок правил в разделе 16.1 ТЗ').toBeTruthy();
  expect(readFileSync('CLAUDE.md', 'utf8').trim()).toBe(block?.trim());
});
