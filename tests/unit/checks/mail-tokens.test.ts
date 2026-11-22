import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { mailTokensDrift } from '../../../scripts/checks/mail-tokens.mjs';
import { buildMailTokens } from '../../../scripts/gen-mail-tokens.mjs';

// Цвета и размеры писем (решение 4 вехи M4): почтовые программы не понимают переменные CSS, поэтому значения
// берутся из src/ui/tokens.css скриптом и лежат в mail-tokens.json. pnpm check падает при расхождении.

const root = resolve(import.meta.dirname, '../../..');
const css = readFileSync(resolve(root, 'src/ui/tokens.css'), 'utf8');
const json = readFileSync(resolve(root, 'src/modules/hdn/mail/mail-tokens.json'), 'utf8');

test('mail-tokens.json совпадает с tokens.css', () => {
  expect(JSON.parse(json)).toEqual(buildMailTokens(css));
  expect(mailTokensDrift(css, json)).toEqual([]);
  const tokens = buildMailTokens(css);
  expect(tokens.color.primary).toBe('#027CAA');
  expect(tokens.color.background).toBe('#F3F6F7');
  expect(tokens.radius.card).toBe('14px');
});

test('расхождение mail-tokens.json ломает проверку', () => {
  const changed = JSON.parse(json);
  changed.color.primary = '#000000';
  expect(mailTokensDrift(css, JSON.stringify(changed))).not.toEqual([]);
  expect(mailTokensDrift(css.replace('--sm-pri: #027CAA;', '--sm-pri: #0288BB;'), json)).not.toEqual([]);
  expect(mailTokensDrift(css, '{')).not.toEqual([]);
});
