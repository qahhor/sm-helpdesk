import { expect, test } from 'vitest';
import { cleanAgentText } from '@/modules/hda/agent/util';

// Текст, который записывает агент (план M8b, решение 18; проверка на AI-инъекции, волна 7, S-M1): очистка повторяется
// до неподвижной точки, оставшиеся угловые скобки не остаются разметкой, ссылкой считается и адрес без границы слова,
// "www." и "//узел".

const DOMAINS = ['smartup.uz'];
const clean = (text: string) => cleanAgentText(text, DOMAINS);

test('вложенная разметка не собирается обратно после одного прохода', () => {
  for (const nested of ['<scr<script>x</script>ipt>alert(1)</scr<b>ipt>', '<<b>script>alert(1)<<i>/script>', '<ifr<!-- -->ame src=x></ifr<!-- -->ame>']) {
    const out = clean(`До ${nested} после`);
    expect(out, nested).not.toMatch(/[<>]/);
    expect(out, nested).not.toMatch(/<\s*(script|iframe)/i);
    expect(out, nested).toContain('До');
    expect(out, nested).toContain('после');
  }
});

test('незакрытый тег и одиночные угловые скобки не остаются угловыми скобками', () => {
  expect(clean('Текст <img src=x onerror=alert(1)')).not.toMatch(/[<>]/);
  const compare = clean('Остаток < 0, а цена > 100');
  expect(compare).not.toMatch(/[<>]/);
  expect(compare).toContain('Остаток');
  expect(compare).toContain('100');
});

test('ссылка без границы слова, "www." и "//узел" вырезаются; разрешённые остаются', () => {
  const out = clean('Смотриhttps://evil.example/a и www.evil.example/b и //evil.example/c и ftp://evil.example/d, а также https://docs.smartup.uz/a и www.smartup.uz/b');
  expect(out).not.toMatch(/evil\.example/);
  expect(out).toContain('https://docs.smartup.uz/a');
  expect(out).toContain('www.smartup.uz/b');
});

test('ссылка, собранная из кусков после вырезания тега, тоже вырезается', () => {
  expect(clean('htt<b></b>ps://evil.example/x')).not.toMatch(/evil\.example/);
});

test('очистка идемпотентна', () => {
  for (const text of ['<<b>script>alert(1)', 'a < b > c', 'Обычный текст\n\n\n\nс абзацами  и   пробелами', 'htt<b></b>ps://evil.example/x']) expect(clean(clean(text)), text).toBe(clean(text));
});
