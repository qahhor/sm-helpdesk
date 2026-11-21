import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Markdown } from '@/ui/components/markdown';

// Переписка выводится как Markdown без HTML (раздел 14.3): ни разметки, ни картинок, ни опасных ссылок.

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test('HTML из текста не выводится: ни <script>, ни <img onerror>', () => {
  const out = html('До <script>alert(1)</script> и <img src=x onerror="alert(2)"> после');
  expect(out).not.toMatch(/<script|<img|onerror/i);
  expect(out).toContain('До');
  expect(out).toContain('после');
});

test('картинки Markdown не загружаются, остаётся подпись', () => {
  const out = html('Смотрите ![скриншот](http://evil.example/track.png)');
  expect(out).not.toMatch(/<img|evil\.example/);
  expect(out).toContain('скриншот');
});

test('ссылки javascript:, data: и vbscript: не становятся ссылками', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)']) {
    const out = html(`[нажми](${href})`);
    expect(out, href).not.toMatch(/href="(?:javascript|data|vbscript)/i);
    expect(out, href).toContain('нажми');
  }
});

test('обычная ссылка открывается в новой вкладке с rel="noopener noreferrer nofollow"', () => {
  // Адрес без скобок ссылкой не становится (без remark-gfm), в угловых скобках становится.
  const out = html('Инструкция: [раздел](https://help.smartup.uz/orders) и <https://smartup.uz>');
  expect(out).toContain('<a href="https://help.smartup.uz/orders" target="_blank" rel="noopener noreferrer nofollow">раздел</a>');
  expect(out).toContain('<a href="https://smartup.uz" target="_blank" rel="noopener noreferrer nofollow">https://smartup.uz</a>');
});

test('абзацы, списки, код и выделение сохраняются', () => {
  const out = html('**Важно**\n\n1. Откройте склад\n2. Проверьте остаток\n\n`код ошибки`');
  expect(out).toContain('<strong>Важно</strong>');
  expect(out).toMatch(/<ol>[\s\S]*<li>Откройте склад<\/li>/);
  expect(out).toContain('<code>код ошибки</code>');
});
