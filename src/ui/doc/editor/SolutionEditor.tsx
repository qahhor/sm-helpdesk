'use client';

import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type Editor } from '@tiptap/react';
import {
  ArrowDown,
  ArrowUp,
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  Code,
  Footprints,
  GripVertical,
  Heading2,
  Heading3,
  ImagePlus,
  Info,
  Italic,
  Link,
  List,
  ListOrdered,
  Pilcrow,
  Redo2,
  Table,
  Trash2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SolutionDoc } from '@/modules/hdk/api/doc';
import { isAllowedHref } from '@/modules/hdk/api/doc-rules';
import { cn } from '@/ui/cn';
import { fromEditorJson, toEditorJson } from './convert';
import { createSolutionExtensions, type ImageSrcResolver } from './extensions';
import { cleanPastedHtml } from './word-paste';
import './editor.css';

// Редактор решения на Tiptap (план M5, задача 1: проба). Блоки только из закрытого списка, панель своя,
// из компонентов портала. Панель инструментов по образцу WAI-ARIA toolbar: одна остановка Tab, внутри
// стрелки, Home и End. Перетаскивание шагов дублируется переносом с клавиатуры (Alt+Shift+стрелка).
// Страницы клиента редактор не подключают никогда (проверяют линтер и tests/e2e/editor-isolation.spec.ts).

export type SolutionEditorLabels = {
  area: string;
  toolbar: string;
  bold: string;
  italic: string;
  code: string;
  link: string;
  linkPrompt: string;
  heading2: string;
  heading3: string;
  paragraph: string;
  bulletList: string;
  orderedList: string;
  step: string;
  calloutWarning: string;
  calloutInfo: string;
  image: string;
  table: string;
  addRow: string;
  addColumn: string;
  deleteTable: string;
  moveUp: string;
  moveDown: string;
  undo: string;
  redo: string;
};

function StepView() {
  return (
    <NodeViewWrapper className="doc-step" data-step="">
      {/* Ручка только для мыши: с клавиатуры шаг переносится кнопками панели и сочетанием клавиш. */}
      <span className="doc-step-handle" contentEditable={false} draggable data-drag-handle="" aria-hidden="true">
        <GripVertical className="size-4" />
      </span>
      <NodeViewContent className="doc-step-body" />
    </NodeViewWrapper>
  );
}

type Tool = { key: keyof SolutionEditorLabels; icon: LucideIcon; run: (editor: Editor) => void; active?: (editor: Editor) => boolean; enabled?: (editor: Editor) => boolean };

function tools(labels: SolutionEditorLabels, image: { fileId: string; alt: string }): Tool[][] {
  return [
    [
      { key: 'bold', icon: Bold, run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
      { key: 'italic', icon: Italic, run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
      { key: 'code', icon: Code, run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive('code') },
      {
        key: 'link',
        icon: Link,
        active: (e) => e.isActive('link'),
        run: (e) => {
          const href = window.prompt(labels.linkPrompt, e.getAttributes('link').href ?? 'https://')?.trim();
          if (href === undefined) return;
          if (href === '') e.chain().focus().extendMarkRange('link').unsetLink().run();
          else if (isAllowedHref(href)) e.chain().focus().extendMarkRange('link').setLink({ href }).run();
        },
      },
    ],
    [
      { key: 'paragraph', icon: Pilcrow, run: (e) => e.chain().focus().setParagraph().run(), active: (e) => e.isActive('paragraph') && !e.isActive('step') },
      { key: 'heading2', icon: Heading2, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive('heading', { level: 2 }) },
      { key: 'heading3', icon: Heading3, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive('heading', { level: 3 }) },
      { key: 'bulletList', icon: List, run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
      { key: 'orderedList', icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
    ],
    [
      { key: 'step', icon: Footprints, run: (e) => e.chain().focus().toggleStep().run(), active: (e) => e.isActive('step') },
      { key: 'calloutWarning', icon: TriangleAlert, run: (e) => e.chain().focus().toggleCallout('warning').run(), active: (e) => e.isActive('callout', { tone: 'warning' }) },
      { key: 'calloutInfo', icon: Info, run: (e) => e.chain().focus().toggleCallout('info').run(), active: (e) => e.isActive('callout', { tone: 'info' }) },
      { key: 'image', icon: ImagePlus, run: (e) => e.chain().focus().insertContent({ type: 'image', attrs: { fileId: image.fileId, alt: image.alt } }).run() },
    ],
    [
      { key: 'table', icon: Table, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run(), enabled: (e) => !e.isActive('table') },
      { key: 'addRow', icon: BetweenHorizontalEnd, run: (e) => e.chain().focus().addRowAfter().run(), enabled: (e) => e.isActive('table') },
      { key: 'addColumn', icon: BetweenVerticalEnd, run: (e) => e.chain().focus().addColumnAfter().run(), enabled: (e) => e.isActive('table') },
      { key: 'deleteTable', icon: Trash2, run: (e) => e.chain().focus().deleteTable().run(), enabled: (e) => e.isActive('table') },
    ],
    [
      { key: 'moveUp', icon: ArrowUp, run: (e) => e.chain().focus().moveBlock('up').run(), enabled: (e) => e.can().moveBlock('up') },
      { key: 'moveDown', icon: ArrowDown, run: (e) => e.chain().focus().moveBlock('down').run(), enabled: (e) => e.can().moveBlock('down') },
      { key: 'undo', icon: Undo2, run: (e) => e.chain().focus().undo().run(), enabled: (e) => e.can().undo() },
      { key: 'redo', icon: Redo2, run: (e) => e.chain().focus().redo().run(), enabled: (e) => e.can().redo() },
    ],
  ];
}

function Toolbar({ editor, labels, groups }: { editor: Editor; labels: SolutionEditorLabels; groups: Tool[][] }) {
  const flat = groups.flat();
  const [focusIndex, setFocusIndex] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Состояние кнопок пересчитывается при каждой правке и смене выделения.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => flat.map((tool) => ({ active: tool.active?.(e) ?? false, enabled: tool.enabled?.(e) ?? true })),
    equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowRight: focusIndex + 1, ArrowLeft: focusIndex - 1, Home: 0, End: flat.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = (moves[event.key]! + flat.length) % flat.length;
    setFocusIndex(next);
    refs.current[next]?.focus();
  };

  const offsets = groups.map((_, g) => groups.slice(0, g).reduce((sum, group) => sum + group.length, 0));
  return (
    <div role="toolbar" aria-label={labels.toolbar} aria-orientation="horizontal" onKeyDown={onKeyDown} className="flex flex-wrap items-center gap-1 border-b border-border p-2">
      {groups.map((group, g) => (
        <div key={g} role="group" className="flex items-center gap-1 pe-2 not-last:border-e not-last:border-border">
          {group.map((tool, t) => {
            const i = offsets[g]! + t;
            const { active, enabled } = state?.[i] ?? { active: false, enabled: true };
            const Icon = tool.icon;
            return (
              <button
                key={tool.key}
                ref={(element) => {
                  refs.current[i] = element;
                }}
                type="button"
                tabIndex={i === focusIndex ? 0 : -1}
                aria-label={labels[tool.key]}
                title={labels[tool.key]}
                aria-pressed={tool.active ? active : undefined}
                disabled={!enabled}
                onFocus={() => setFocusIndex(i)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => tool.run(editor)}
                className={cn(
                  'inline-flex size-control-small items-center justify-center rounded-control text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                  active && 'bg-selected text-selected-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export type SolutionEditorProps = {
  initial: SolutionDoc;
  labels: SolutionEditorLabels;
  /** Адрес файла решения для показа изображения: в документе хранится только fileId (план M5, решение 16). */
  imageSrc: ImageSrcResolver;
  /** Файл для кнопки "Изображение". Загрузка файлов появится в задаче 3 и заменит эту заготовку. */
  insertImage: { fileId: string; alt: string };
  /** Документ для сохранения после каждой правки (ещё не проверен схемой). */
  onChange?: (doc: { version: 1; blocks: unknown[] }) => void;
  /** Только на странице пробы: редактор доступен браузерному тесту как window.__solutionEditor. */
  exposeForTests?: boolean;
};

export function SolutionEditor({ initial, labels, imageSrc, insertImage, onChange, exposeForTests }: SolutionEditorProps) {
  const editor = useEditor({
    extensions: createSolutionExtensions({ stepView: ReactNodeViewRenderer(StepView), imageSrc }),
    content: toEditorJson(initial),
    immediatelyRender: false,
    injectCSS: false,
    editorProps: {
      attributes: { class: 'doc-editor', 'aria-label': labels.area, 'aria-multiline': 'true', role: 'textbox' },
      transformPastedHTML: cleanPastedHtml,
    },
    onUpdate: ({ editor: e }) => onChange?.(fromEditorJson(e.getJSON())),
  });

  useEffect(() => {
    if (!editor || !exposeForTests) return;
    (window as unknown as { __solutionEditor?: Editor }).__solutionEditor = editor;
    return () => {
      delete (window as unknown as { __solutionEditor?: Editor }).__solutionEditor;
    };
  }, [editor, exposeForTests]);

  if (!editor) return <div className="min-h-row rounded-card border border-border bg-card" aria-busy="true" />;
  return (
    <div className="rounded-card border border-border bg-card">
      <Toolbar editor={editor} labels={labels} groups={tools(labels, insertImage)} />
      <EditorContent editor={editor} />
    </div>
  );
}
