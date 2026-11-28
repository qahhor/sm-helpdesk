import ReactMarkdown, { type Components } from 'react-markdown';
import { cn } from '@/ui/cn';

// Текст переписки как Markdown без HTML (раздел 14.3): разметка HTML из текста не исполняется, а показывается текстом,
// картинки не загружаются (остаются подпись и адрес текстом), ссылки только http, https и mailto, открываются в новой вкладке без
// передачи адреса страницы. Компонент серверный: на странице обращения он не добавляет скриптов.
//
// Человек видит всё, что видит модель (проверка на AI-инъекции, волна 7, S-I1; решение 0148): комментарий HTML, блок
// <div>, определение сноски `[1]: адрес "текст"`, адрес и подпись ссылки и картинки, строка после ``` у блока кода
// уходят модели и агенту как текст, поэтому на экране они тоже текст, а не пропуск.

const SAFE_URL = /^(?:https?:|mailto:)/i;

type MdNode = {
  type: string;
  children?: MdNode[];
  value?: string;
  label?: string | null;
  identifier?: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  meta?: string | null;
};

const text = (value: string): MdNode => ({ type: 'text', value });
const quoted = (title?: string | null) => (title ? ` "${title}"` : '');
const plain = (node: MdNode): string => node.value ?? node.alt ?? (node.children ?? []).map(plain).join('');

/**
 * Всё, что разметка прячет от глаз, дописывается в дерево текстом (решение 0148, находка R1 независимой проверки):
 * - определение сноски показывается абзацем сразу после себя. Само определение остаётся в дереве: ссылки вида
 *   [текст][1] по-прежнему находят адрес;
 * - после ссылки идёт её адрес и подпись в кавычках, кроме случая, когда адрес и есть текст ссылки. Адрес берётся из
 *   исходного текста, до проверки схемы: `[](<указание модели>)` иначе не оставило бы следа;
 * - картинка заменяется текстом: подпись, адрес, подпись в кавычках. Картинка могла бы следить за читателем, а адрес
 *   при пустой подписи был бы виден только модели;
 * - над блоком кода пишется строка после ```: язык и всё, что за ним.
 * Ссылки и картинки по сноске ([текст][1], ![][1]) адрес не повторяют: он уже показан в определении.
 */
function showHidden() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    const out: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === 'definition') {
        out.push(child, { type: 'paragraph', children: [text(`[${child.label ?? child.identifier ?? ''}]: ${child.url ?? ''}${quoted(child.title)}`)] });
      } else if (child.type === 'image') {
        const address = `(${child.url ?? ''}${quoted(child.title)})`;
        out.push(text(child.alt ? `${child.alt} ${address}` : address));
      } else if (child.type === 'link') {
        walk(child);
        out.push(child);
        const url = child.url ?? '';
        const shown = plain(child);
        if (child.title || (url !== shown && url !== `mailto:${shown}`)) out.push(text(` (${url}${quoted(child.title)})`));
      } else if (child.type === 'code') {
        const info = [child.lang, child.meta].filter(Boolean).join(' ');
        if (info) out.push({ type: 'paragraph', children: [text(info)] });
        out.push(child);
      } else {
        walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  return (tree: MdNode) => walk(tree);
}

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Картинка по сноске: вместо неё подпись, адрес показан в определении.
  img: ({ alt, title }) => <span>{[alt, title].filter(Boolean).join(' ')}</span>,
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 break-words [&_a]:text-link [&_a]:underline [&_code]:rounded-control [&_code]:bg-card-soft [&_code]:px-1',
        '[&_ol]:list-decimal [&_ol]:ps-5 [&_ul]:list-disc [&_ul]:ps-5 [&_pre]:overflow-x-auto [&_blockquote]:border-s-2 [&_blockquote]:border-border [&_blockquote]:ps-3',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[showHidden]} urlTransform={(url) => (SAFE_URL.test(url.trim()) ? url : '')} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
