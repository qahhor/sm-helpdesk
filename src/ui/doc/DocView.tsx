import type { ReactNode } from 'react';
import type {
  Block,
  CalloutNode,
  ImageNode,
  InlineNode,
  ListItemNode,
  ListNode,
  ParagraphNode,
  SolutionDoc,
  StepNode,
  TableNode,
  TextNode,
} from '@/modules/hdk/doc-schema';
import { cn } from '@/ui/cn';

// Отрисовка документа решения (ТЗ 18.10; план M5, задачи 1 и 2): обход проверенной схемой структуры и
// React-компонент на каждый вид блока. Строка HTML не собирается и не вставляется: текст попадает в разметку
// только как текст, React его экранирует. Компонент серверный и не тянет редактор: одна и та же отрисовка
// для предпросмотра сотрудника и для страницы клиента. Документ на вход приходит уже проверенным
// (parseSolutionDoc из @/modules/hdk/api/doc).

export type DocViewLabels = {
  /** Подпись предупреждения. */
  warning: string;
  /** Подпись заметки. */
  info: string;
  /** Подпись номера шага для экранного чтения и печати: "Шаг 2". */
  step: (n: number) => string;
};

type Ctx = { labels: DocViewLabels };

function TextRun({ node }: { node: TextNode }) {
  let out: ReactNode = node.text;
  // Порядок вложения постоянный, чтобы одинаковый текст давал одинаковую разметку.
  for (const mark of node.marks ?? []) {
    if (mark.type === 'code') out = <code>{out}</code>;
    else if (mark.type === 'bold') out = <strong>{out}</strong>;
    else if (mark.type === 'italic') out = <em>{out}</em>;
  }
  const link = node.marks?.find((mark) => mark.type === 'link');
  if (link)
    out = link.attrs.href.startsWith('/') ? (
      <a href={link.attrs.href}>{out}</a>
    ) : (
      <a href={link.attrs.href} rel="noopener noreferrer nofollow" target="_blank">
        {out}
      </a>
    );
  return out;
}

function Inline({ content }: { content: InlineNode[] | undefined }) {
  return (content ?? []).map((node, index) => (node.type === 'hardBreak' ? <br key={index} /> : <TextRun key={index} node={node} />));
}

function Paragraph({ node }: { node: ParagraphNode }) {
  return (
    <p data-block={node.attrs.id} className="min-h-lh">
      <Inline content={node.content} />
    </p>
  );
}

function ImageBlock({ node }: { node: ImageNode }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- файл решения отдаёт портал после проверки прав, оптимизатор выключен
    <img data-block={node.attrs.id} src={node.attrs.src} alt={node.attrs.alt ?? ''} loading="lazy" className="max-w-full self-start rounded-control border border-border" />
  );
}

function ListItem({ node, ctx }: { node: ListItemNode; ctx: Ctx }) {
  return (
    <li>
      {node.content.map((child) => (child.type === 'paragraph' ? <Paragraph key={child.attrs.id} node={child} /> : <List key={child.attrs.id} node={child} ctx={ctx} />))}
    </li>
  );
}

function List({ node, ctx }: { node: ListNode; ctx: Ctx }) {
  const items = node.content.map((item, index) => <ListItem key={item.content[0].attrs.id ?? index} node={item} ctx={ctx} />);
  return node.type === 'bulletList' ? (
    <ul data-block={node.attrs.id} className="flex list-disc flex-col gap-1 ps-5">
      {items}
    </ul>
  ) : (
    <ol data-block={node.attrs.id} start={node.attrs.start} className="flex list-decimal flex-col gap-1 ps-5">
      {items}
    </ol>
  );
}

function Steps({ steps, ctx }: { steps: StepNode[]; ctx: Ctx }) {
  return (
    <ol data-steps="" className="flex flex-col gap-3">
      {steps.map((step, index) => (
        <li key={step.attrs.id} data-block={step.attrs.id} className="flex gap-3">
          <span aria-hidden="true" className="flex size-control-small shrink-0 items-center justify-center rounded-chip bg-selected font-semibold text-selected-foreground">
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-col gap-2 pt-2">
            <span className="sr-only">{ctx.labels.step(index + 1)}</span>
            {step.content.map((child) => (child.type === 'paragraph' ? <Paragraph key={child.attrs.id} node={child} /> : <ImageBlock key={child.attrs.id} node={child} />))}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Callout({ node, ctx }: { node: CalloutNode; ctx: Ctx }) {
  const warning = node.attrs.tone === 'warning';
  return (
    <aside
      data-block={node.attrs.id}
      data-tone={node.attrs.tone}
      className={cn('flex flex-col gap-2 rounded-control border-s-4 p-3', warning ? 'border-warning bg-warning-bg' : 'border-link bg-card-soft')}
    >
      <strong className="text-sm">{warning ? ctx.labels.warning : ctx.labels.info}</strong>
      {node.content.map((child) => (child.type === 'paragraph' ? <Paragraph key={child.attrs.id} node={child} /> : <List key={child.attrs.id} node={child} ctx={ctx} />))}
    </aside>
  );
}

function Table({ node }: { node: TableNode }) {
  return (
    <div className="overflow-x-auto">
      <table data-block={node.attrs.id} className="w-full border-collapse text-sm">
        <tbody>
          {node.content.map((row, r) => (
            <tr key={r}>
              {row.content.map((cell, c) => {
                const Cell = cell.type === 'tableHeader' ? 'th' : 'td';
                return (
                  <Cell
                    key={c}
                    colSpan={cell.attrs.colspan > 1 ? cell.attrs.colspan : undefined}
                    rowSpan={cell.attrs.rowspan > 1 ? cell.attrs.rowspan : undefined}
                    className={cn('border border-border p-2 text-start align-top', cell.type === 'tableHeader' && 'bg-card-soft font-semibold')}
                  >
                    {cell.content.map((p) => (
                      <Paragraph key={p.attrs.id} node={p} />
                    ))}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockView({ block, ctx }: { block: Exclude<Block, StepNode>; ctx: Ctx }) {
  switch (block.type) {
    case 'heading': {
      const Tag = block.attrs.level === 2 ? 'h2' : 'h3';
      return (
        <Tag id={`b-${block.attrs.id}`} className={block.attrs.level === 2 ? 'text-lg font-semibold' : 'font-semibold'}>
          <Inline content={block.content} />
        </Tag>
      );
    }
    case 'paragraph':
      return <Paragraph node={block} />;
    case 'bulletList':
    case 'orderedList':
      return <List node={block} ctx={ctx} />;
    case 'callout':
      return <Callout node={block} ctx={ctx} />;
    case 'table':
      return <Table node={block} />;
    case 'image':
      return <ImageBlock node={block} />;
  }
}

/** Соседние шаги собираются в один нумерованный список: нумерация идёт по порядку, без хранимых номеров. */
function group(blocks: Block[]): (Exclude<Block, StepNode> | StepNode[])[] {
  const out: (Exclude<Block, StepNode> | StepNode[])[] = [];
  for (const block of blocks) {
    const last = out.at(-1);
    if (block.type !== 'step') out.push(block);
    else if (Array.isArray(last)) last.push(block);
    else out.push([block]);
  }
  return out;
}

export function DocView({ doc, labels, className }: { doc: SolutionDoc; labels: DocViewLabels; className?: string }) {
  const ctx: Ctx = { labels };
  return (
    <div className={cn('flex flex-col gap-3 break-words [&_a]:text-link [&_a]:underline [&_code]:rounded-control [&_code]:bg-card-soft [&_code]:px-1', className)}>
      {group(doc.blocks).map((item) =>
        Array.isArray(item) ? <Steps key={item[0]!.attrs.id} steps={item} ctx={ctx} /> : <BlockView key={item.attrs.id} block={item} ctx={ctx} />,
      )}
    </div>
  );
}
