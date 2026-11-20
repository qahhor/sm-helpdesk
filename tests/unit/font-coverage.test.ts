import { readFileSync, statSync } from 'node:fs';
import { expect, test } from 'vitest';
import { fontsOutOfDate } from '../../scripts/fonts/build.mjs';
import { codePointsOf } from './helpers/tokens';

const REQUIRED = [
  // узбекские апострофы
  0x02bb, 0x02bc, 0x0027,
  // узбекская кириллица
  0x040e, 0x045e, 0x049a, 0x049b, 0x0492, 0x0493, 0x04b2, 0x04b3,
  // казахские буквы
  0x04d9, 0x04a3, 0x04e9, 0x04b1, 0x04af, 0x04bb, 0x0456,
  // турецкие буквы и буквы новой узбекской латиницы
  0x011e, 0x011f, 0x0130, 0x0131, 0x015e, 0x015f, 0x00c7, 0x00e7, 0x00d6, 0x00f6, 0x00fc,
  // знаки интерфейса: неразрывный пробел, номер, минус, сум не имеет знака
  0x00a0, 0x2116, 0x2212,
];
const WEIGHTS = [400, 500, 600, 700] as const;

test.each(WEIGHTS)('файл для веба %i содержит узбекские, казахские и турецкие знаки (UX-S-16)', (w) => {
  const covered = codePointsOf(`src/ui/fonts/montserrat-${w}.woff2`);
  expect(REQUIRED.filter((cp) => !covered.has(cp)).map((cp) => cp.toString(16))).toEqual([]);
});

test.each(WEIGHTS)('файл для веба %i содержит русский и английский алфавит и цифры', (w) => {
  const covered = codePointsOf(`src/ui/fonts/montserrat-${w}.woff2`);
  const text = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюяABCXYZabcxyz0123456789.,:;!?()%+';
  expect([...text].filter((ch) => !covered.has(ch.codePointAt(0) as number))).toEqual([]);
});

test('файлы для веба собраны из шрифта пакета бренда и не устарели', async () => {
  expect(await fontsOutOfDate()).toEqual([]);
});

test('четыре файла вместе не тяжелее 400 КБ', () => {
  const total = WEIGHTS.reduce((sum, w) => sum + statSync(`src/ui/fonts/montserrat-${w}.woff2`).size, 0);
  expect(total).toBeLessThanOrEqual(400 * 1024);
});

test('шрифт не грузится с внешнего сервера', () => {
  const css = readFileSync('src/ui/font.css', 'utf8') + readFileSync('src/app/globals.css', 'utf8');
  expect(css).not.toMatch(/https?:\/\//);
  for (const w of WEIGHTS) expect(css).toContain(`montserrat-${w}.woff2`);
});
