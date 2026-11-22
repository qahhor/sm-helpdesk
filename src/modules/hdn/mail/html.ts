// Модуль hdn: HTML писем без библиотек (решение 4 вехи M4). Любой текст экранируется, из Markdown ответа
// сотрудника остаются абзацы, списки, жирный, курсив, код и ссылки http и https. Картинок из текста нет:
// внешние картинки в письме выдают факт открытия и могут быть приманкой.

export function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Ссылка только http или https, иначе null. */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function link(url: string, label: string, color: string): string {
  return `<a href="${esc(url)}" style="color:${esc(color)};text-decoration:underline">${esc(label)}</a>`;
}

/** Выделение внутри уже экранированного текста: **жирный**, *курсив*, `код`. */
function emphasis(escaped: string): string {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

const LINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/** Строка Markdown: ссылки и картинки разбираются до экранирования, остальной текст экранируется. */
function inline(text: string, linkColor: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    out += emphasis(esc(text.slice(last, match.index)));
    const [, image, label = '', target = ''] = match;
    const url = safeUrl(target);
    // Картинка становится подписью, ссылка с неподходящей схемой текстом.
    out += image || !url ? esc(label) : link(url, label || url, linkColor);
    last = (match.index ?? 0) + match[0].length;
  }
  return out + emphasis(esc(text.slice(last)));
}

const LIST_ITEM = /^\s*(?:[-*]|\d{1,3}[.)])\s+(.*)$/;

/** Markdown ответа сотрудника в простой HTML письма. */
export function markdownToHtml(markdown: string, style: { paragraph: string; linkColor: string }): string {
  const blocks = markdown.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    if (lines.every((line) => LIST_ITEM.test(line))) {
      const ordered = /^\s*\d/.test(lines[0] ?? '');
      const items = lines.map((line) => `<li>${inline(LIST_ITEM.exec(line)?.[1] ?? '', style.linkColor)}</li>`).join('');
      out.push(ordered ? `<ol style="${style.paragraph}">${items}</ol>` : `<ul style="${style.paragraph}">${items}</ul>`);
    } else out.push(`<p style="${style.paragraph}">${lines.map((line) => inline(line, style.linkColor)).join('<br>')}</p>`);
  }
  return out.join('');
}

const URL_LINE = /^https?:\/\/\S+$/;

/** Простой текст (письма M1): абзацы по пустой строке, строка из одной ссылки становится ссылкой. */
export function textToHtml(text: string, style: { paragraph: string; linkColor: string }): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n').map((line) => {
        const trimmed = line.trim();
        const url = URL_LINE.test(trimmed) ? safeUrl(trimmed) : null;
        return url ? link(url, trimmed, style.linkColor) : esc(line);
      });
      return `<p style="${style.paragraph}">${lines.join('<br>')}</p>`;
    })
    .join('');
}
