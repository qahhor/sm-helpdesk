// Собирает файлы шрифта для веба из шрифта пакета бренда (docs/brand/fonts/Montserrat).
// Исходные TTF весят 1,3 МБ и пользователю не отдаются. В WOFF2 остаются знаки языков портала
// и ближайших к ним: латиница с расширениями, кириллица с расширениями, пунктуация, цифры.
//
// Запуск: pnpm fonts:build. Результат (src/ui/fonts) коммитится.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const SOURCE_DIR = 'docs/brand/fonts/Montserrat';
const OUTPUT_DIR = 'src/ui/fonts';
const MANIFEST = `${OUTPUT_DIR}/sources.json`;

const WEIGHTS = { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold' };

// Диапазоны Юникода, которые остаются в шрифте.
const RANGES = [
  [0x0020, 0x007e], // основная латиница, цифры, знаки
  [0x00a0, 0x00ff], // неразрывный пробел, дополнение латиницы
  [0x0100, 0x024f], // расширенная латиница A и B: турецкий, новая узбекская латиница
  [0x02b0, 0x02ff], // модификаторы: узбекские апострофы U+02BB и U+02BC
  [0x0400, 0x052f], // кириллица с расширениями: узбекская, казахская, таджикская
  [0x2000, 0x206f], // общая пунктуация: кавычки, многоточие, тонкие пробелы
  [0x20a0, 0x20bf], // знаки валют
  [0x2116, 0x2116], // знак номера
  [0x2122, 0x2122], // товарный знак
  [0x2190, 0x2193], // стрелки
  [0x2212, 0x2212], // минус
  [0x2248, 0x2248], // примерно равно
  [0x2260, 0x2265], // не равно, меньше или равно, больше или равно
];

const sourcePath = (weight) => `${SOURCE_DIR}/Montserrat_${weight}${WEIGHTS[weight]}.ttf`;
const outputPath = (weight) => `${OUTPUT_DIR}/montserrat-${weight}.woff2`;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const rangesId = sha256(JSON.stringify(RANGES));

function charactersToKeep() {
  let text = '';
  for (const [from, to] of RANGES) for (let cp = from; cp <= to; cp++) text += String.fromCodePoint(cp);
  return text;
}

export async function buildFonts() {
  const { default: subsetFont } = await import('subset-font');
  await mkdir(resolve(root, OUTPUT_DIR), { recursive: true });
  const manifest = { ranges: rangesId, sources: {}, outputs: {} };
  for (const weight of Object.keys(WEIGHTS)) {
    const source = await readFile(resolve(root, sourcePath(weight)));
    const woff2 = await subsetFont(source, charactersToKeep(), { targetFormat: 'woff2' });
    await writeFile(resolve(root, outputPath(weight)), woff2);
    manifest.sources[weight] = sha256(source);
    manifest.outputs[weight] = sha256(woff2);
    console.log(`${outputPath(weight)}: ${Math.round(woff2.length / 1024)} КБ`);
  }
  await writeFile(resolve(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Какие файлы для веба не соответствуют исходным TTF, набору знаков или записи о сборке.
 * @returns {Promise<string[]>} пустой список, если всё актуально
 */
export async function fontsOutOfDate() {
  if (!existsSync(resolve(root, MANIFEST))) return [MANIFEST];
  const manifest = JSON.parse(await readFile(resolve(root, MANIFEST), 'utf8'));
  /** @type {string[]} */
  const stale = [];
  if (manifest.ranges !== rangesId) stale.push('набор знаков изменён');
  for (const weight of Object.keys(WEIGHTS)) {
    const source = await readFile(resolve(root, sourcePath(weight)));
    if (manifest.sources?.[weight] !== sha256(source)) stale.push(sourcePath(weight));
    const built = existsSync(resolve(root, outputPath(weight))) ? await readFile(resolve(root, outputPath(weight))) : null;
    if (!built || manifest.outputs?.[weight] !== sha256(built)) stale.push(outputPath(weight));
  }
  return stale;
}

if (import.meta.main) await buildFonts();
