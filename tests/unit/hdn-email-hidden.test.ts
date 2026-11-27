import { expect, test } from 'vitest';
import { emailToText } from '@/modules/hdn/inbound/email-text';

// Скрытый текст письма классами стилей и новыми признаками (FR-EM-15, отложено решением 0035; план M5b, задача 2,
// решение 20). Скрытое не попадает ни в текст обращения, ни во вход модели: модель получает ровно этот текст.

const SECRET = 'ИНСТРУКЦИЯ ДЛЯ МОДЕЛИ';
const VISIBLE = '<p>Не печатается накладная</p>';

test.each([
  ['класс с display:none', `<style>.x { display: none }</style>${VISIBLE}<div class="a x">${SECRET}</div>`],
  ['идентификатор с visibility:hidden', `<style>#h{visibility:hidden}</style>${VISIBLE}<span id="h">${SECRET}</span>`],
  ['тег с display:none', `<style>font { display:none !important }</style>${VISIBLE}<font>${SECRET}</font>`],
  ['селектор в списке и в @media', `<style>@media screen { p.a, .y { display:none } }</style>${VISIBLE}<span class="y">${SECRET}</span>`],
  ['потомок: берётся последний простой селектор', `<style>table .z{display:none}</style>${VISIBLE}<span class="z">${SECRET}</span>`],
  ['шрифт 1px классом', `<style>.t{font-size:1px}</style>${VISIBLE}<span class="t">${SECRET}</span>`],
  ['шрифт 1px встроенным стилем', `${VISIBLE}<span style="font-size:1px">${SECRET}</span>`],
  ['шрифт 2pt', `${VISIBLE}<span style="font-size:2pt">${SECRET}</span>`],
  ['шрифт 0.1em', `${VISIBLE}<span style="font-size:0.1em">${SECRET}</span>`],
  ['прозрачность 0.05', `${VISIBLE}<span style="opacity:0.05">${SECRET}</span>`],
  ['вынос за экран', `${VISIBLE}<div style="position:absolute;left:-9999px">${SECRET}</div>`],
  ['вынос за экран классом', `<style>.off{position:fixed;top:-2000px}</style>${VISIBLE}<div class="off">${SECRET}</div>`],
  ['отступ текста', `${VISIBLE}<div style="text-indent:-9999px">${SECRET}</div>`],
  ['почти белый цвет', `${VISIBLE}<span style="color:#fafafa">${SECRET}</span>`],
  ['почти белый цвет классом через rgb', `<style>.w{color:rgb(250, 250, 248)}</style>${VISIBLE}<span class="w">${SECRET}</span>`],
  ['почти белый цвет словом', `${VISIBLE}<span style="color:snow">${SECRET}</span>`],
  ['высота 0 классом', `<style>.c{height:0;overflow:hidden}</style>${VISIBLE}<div class="c">${SECRET}</div>`],
  // Независимая проверка M5b, M2: старый тег <font> с атрибутами, как решение 20 для стилей.
  ['<font color> почти белый', `${VISIBLE}<font color="#ffffff">${SECRET}</font>`],
  ['<font color> словом', `${VISIBLE}<font color="white">${SECRET}</font>`],
  ['<font size="1">', `${VISIBLE}<font size="1">${SECRET}</font>`],
  ['комментарий внутри стилей не мешает', `<style>/* x */ .k /* y */ {display:none}</style>${VISIBLE}<i class="k">${SECRET}</i>`],
])('%s: инструкции в итоговом тексте нет', (_name, html) => {
  const text = emailToText({ html, text: null }, { keepQuote: true });
  expect(text).toContain('Не печатается накладная');
  expect(text).not.toContain(SECRET);
});

test.each([
  ['серый текст', `<span style="color:#999999">Видимый серый</span>`],
  ['светло-серый, но не белый', `<span style="color:#cccccc">Видимый серый</span>`],
  ['обычный шрифт 12px', `<span style="font-size:12px">Видимый серый</span>`],
  ['класс без скрытия', `<style>.g{color:#777;font-weight:bold}</style><span class="g">Видимый серый</span>`],
  ['<font color> серый', `<font color="#777777">Видимый серый</font>`],
  ['<font size="2">', `<font size="2">Видимый серый</font>`],
  ['вынос на 10px', `<span style="position:relative;left:-10px">Видимый серый</span>`],
  ['псевдокласс не считается', `<style>.h:hover{display:none}</style><span class="h">Видимый серый</span>`],
  ['другой класс', `<style>.x{display:none}</style><span class="xx">Видимый серый</span>`],
])('%s: видимый текст остаётся', (_name, html) => {
  expect(emailToText({ html, text: null })).toBe('Видимый серый');
});
