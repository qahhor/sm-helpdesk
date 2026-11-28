import ReactMarkdown, { type Components } from 'react-markdown';
import { cn } from '@/ui/cn';

// Текст переписки как Markdown без HTML (раздел 14.3): разметка HTML из текста не исполняется, а показывается текстом,
// картинки не загружаются (остаётся подпись), ссылки только http, https и mailto, открываются в новой вкладке без
// передачи адреса страницы. Компонент серверный: на странице обращения он не добавляет скриптов.
//
// Человек видит всё, что видит модель (проверка на AI-инъекции, волна 7, S-I1; решение 0148): комментарий HTML, блок
// <div>, определение сноски `[1]: адрес "текст"` и подпись ссылки в кавычках уходят модели и агенту как текст, поэтому
// на экране они тоже текст, а не пропуск.

const SAFE_URL = /^(?:https?:|mailto:)/i;

type MdNode = { type: string; children?: MdNode[]; value?: string; label?: string | null; identifier?: string; url?: string; title?: string | null };

/**
 * Определения сносок показываются абзацем текста сразу после себя. Само определение остаётся в дереве: ссылки вида
 * [текст][1] по-прежнему находят адрес. Без этого определение, на которое никто не ссылается, на экране исчезает.
 */
function showDefinitions() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    const out: MdNode[] = [];
    for (const child of node.children) {
      out.push(child);
      if (child.type === 'definition') {
        const title = child.title ? ` "${child.title}"` : '';
        out.push({ type: 'paragraph', children: [{ type: 'text', value: `[${child.label ?? child.identifier ?? ''}]: ${child.url ?? ''}${title}` }] });
      } else walk(child);
    }
    node.children = out;
  };
  return (tree: MdNode) => walk(tree);
}

const COMPONENTS: Components = {
  a: ({ href, title, children }) => (
    <>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      )}
      {title ? <span> ({title})</span> : null}
    </>
  ),
  // Картинка из текста могла бы следить за читателем: вместо неё подпись.
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
      <ReactMarkdown remarkPlugins={[showDefinitions]} urlTransform={(url) => (SAFE_URL.test(url.trim()) ? url : '')} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
