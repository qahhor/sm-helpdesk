import ReactMarkdown, { type Components } from 'react-markdown';
import { cn } from '@/ui/cn';

// Текст переписки как Markdown без HTML (раздел 14.3): разметка из текста пропускается, картинки не загружаются
// (остаётся подпись), ссылки только http, https и mailto, открываются в новой вкладке без передачи адреса страницы.
// Компонент серверный: на странице обращения он не добавляет скриптов.

const SAFE_URL = /^(?:https?:|mailto:)/i;

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Картинка из текста могла бы следить за читателем: вместо неё подпись.
  img: ({ alt }) => <span>{alt}</span>,
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
      <ReactMarkdown skipHtml urlTransform={(url) => (SAFE_URL.test(url.trim()) ? url : '')} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
