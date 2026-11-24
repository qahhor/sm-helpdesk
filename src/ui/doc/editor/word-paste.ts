// Вставка из Word (UX-W-11; план M5, задача 1, проверка 3). Word кладёт в буфер HTML со своими приметами:
// списки это абзацы MsoListParagraph со стилем mso-list и номером внутри условного комментария
// <![if !supportLists]>, пустые абзацы с <o:p>&nbsp;</o:p>, заголовок документа как p.MsoTitle, VML-рисунки.
// Здесь эта разметка приводится к обычному HTML: настоящие <ol>/<ul>, заголовки второго и третьего уровня,
// без пустых абзацев и служебных элементов. Остальное делает разбор ProseMirror по закрытой схеме: стили,
// цвета, шрифты, подчёркивание, ссылки и изображения вне списка допустимых до документа не доходят.
// Работает в браузере (DOMParser); разметка разбирается в отдельном неактивном документе, скрипты в нём не идут.

import { isFileId } from '@/modules/hdk/api/doc-rules';

const WORD_SIGNS = /urn:schemas-microsoft-com:office|class=["']?Mso|mso-[a-z-]+:/i;
const ORDERED_MARKER = /^\(?(?:\d{1,3}|[a-zа-я]{1,2}|[ivxlcdm]{1,5})[.)]/i;
const DROP = 'script, style, meta, link, title, template, iframe, object, embed, noscript';

export function looksLikeWord(html: string): boolean {
  return WORD_SIGNS.test(html);
}

function styleOf(element: Element): string {
  return element.getAttribute('style') ?? '';
}

function isListParagraph(element: Element): boolean {
  return element.tagName === 'P' && (/^MsoListParagraph/i.test(element.getAttribute('class') ?? '') || /mso-list:\s*l\d/i.test(styleOf(element)));
}

/** Номер пункта ("1.", "a)", "·") и удаление его из абзаца. */
function takeMarker(paragraph: Element): string {
  let marker = '';
  // Номер внутри <![if !supportLists]> ... <![endif]>: разбор HTML делает из этих скобок комментарии.
  const nodes = [...paragraph.childNodes];
  const open = nodes.findIndex((node) => node.nodeType === 8 && /\[if !supportLists\]/i.test(node.textContent ?? ''));
  if (open >= 0) {
    const close = nodes.findIndex((node, index) => index > open && node.nodeType === 8 && /\[endif\]/i.test(node.textContent ?? ''));
    const inside = nodes.slice(open, close >= 0 ? close + 1 : open + 1);
    marker = inside.map((node) => (node.nodeType === 8 ? '' : (node.textContent ?? ''))).join('');
    inside.forEach((node) => node.parentNode?.removeChild(node));
  }
  // Запасной путь: номер в <span style="mso-list:Ignore">.
  for (const span of paragraph.querySelectorAll('span')) {
    if (!/mso-list:\s*Ignore/i.test(styleOf(span))) continue;
    marker ||= span.textContent ?? '';
    span.remove();
  }
  return marker.replace(/[\s ]+/g, ' ').trim();
}

/** Подряд идущие абзацы-пункты Word превращаются во вложенные списки. */
function convertLists(body: HTMLElement) {
  const doc = body.ownerDocument;
  for (const first of [...body.querySelectorAll('p')]) {
    if (!first.isConnected || !isListParagraph(first)) continue;
    const group: Element[] = [first];
    let next = first.nextElementSibling;
    while (next && isListParagraph(next)) {
      group.push(next);
      next = next.nextElementSibling;
    }
    const stack: { level: number; list: HTMLElement }[] = [];
    let root: HTMLElement | null = null;
    for (const paragraph of group) {
      const level = Number(/level(\d+)/i.exec(styleOf(paragraph))?.[1] ?? '1');
      const ordered = ORDERED_MARKER.test(takeMarker(paragraph));
      while (stack.length > 0 && stack.at(-1)!.level > level) stack.pop();
      if (stack.length === 0 || stack.at(-1)!.level < level) {
        const list = doc.createElement(ordered ? 'ol' : 'ul');
        const parent = stack.at(-1);
        if (parent) (parent.list.lastElementChild ?? parent.list.appendChild(doc.createElement('li'))).appendChild(list);
        else root = list;
        stack.push({ level, list });
      }
      const item = doc.createElement('li');
      const text = doc.createElement('p');
      while (paragraph.firstChild) text.appendChild(paragraph.firstChild);
      item.appendChild(text);
      stack.at(-1)!.list.appendChild(item);
    }
    first.replaceWith(root!);
    group.slice(1).forEach((paragraph) => paragraph.remove());
  }
}

function rename(element: Element, tag: string) {
  const replacement = element.ownerDocument.createElement(tag);
  while (element.firstChild) replacement.appendChild(element.firstChild);
  element.replaceWith(replacement);
}

/** Чистит HTML из Word. Разметка не из Word возвращается как есть: её разбирает схема редактора. */
export function cleanPastedHtml(html: string): string {
  if (!looksLikeWord(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  body.querySelectorAll(DROP).forEach((element) => element.remove());
  convertLists(body);
  // Служебные элементы Word с приставкой (o:p, v:shape, w:sdt): у o:p остаётся текст, VML-рисунки уходят целиком.
  for (const element of [...body.querySelectorAll('*')]) {
    if (!element.isConnected || !element.tagName.includes(':')) continue;
    if (/^O:P$/i.test(element.tagName)) element.replaceWith(...element.childNodes);
    else element.remove();
  }
  // Комментарии, в том числе условные <!--[if gte vml 1]>.
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((comment) => comment.parentNode?.removeChild(comment));
  // Заголовки: в теле решения только второй и третий уровень, первый это заголовок решения.
  body.querySelectorAll('h1').forEach((h) => rename(h, 'h2'));
  body.querySelectorAll('h4, h5, h6').forEach((h) => rename(h, 'h3'));
  body.querySelectorAll('p.MsoTitle').forEach((p) => rename(p, 'h2'));
  body.querySelectorAll('p.MsoSubtitle').forEach((p) => rename(p, 'h3'));
  // Рисунки из буфера Word ссылаются на временные файлы (file:///...): их не загрузить, абзац с ними пустой.
  // В документ попадает только изображение со ссылкой на файл решения (решение 16 плана M5).
  body.querySelectorAll('img').forEach((img) => {
    if (!isFileId(img.getAttribute('data-file-id'))) img.remove();
  });
  // Пустые абзацы Word (<o:p>&nbsp;</o:p>) не нужны: отступы задаёт портал.
  body.querySelectorAll('p').forEach((p) => {
    if ((p.textContent ?? '').replace(/[\s ]/g, '') === '' && !p.querySelector('img')) p.remove();
  });
  return body.innerHTML;
}
