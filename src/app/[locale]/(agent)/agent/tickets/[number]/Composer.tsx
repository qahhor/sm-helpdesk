'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FilePicker, type FilePickerLabels } from '@/ui/components/file-picker';
import { Label } from '@/ui/components/label';
import { RadioGroup } from '@/ui/components/radio-group';
import { Textarea } from '@/ui/components/textarea';
import { filterTemplates, slashQuery } from '@/lib/templates';
import { cn } from '@/ui/cn';
import { type ComposerState, saveDraftAction, staffMessageAction } from './actions';
import { ChangedWarning, type ChangedLabels } from './ChangedWarning';
import { TYPING_EVENT } from './PresenceBar';
import { type PickerTemplate, TemplatePicker } from './TemplatePicker';
import { useHotkey } from '@/ui/hotkeys/bus';

// Поле ответа агента (FR-AG-03, 8.4): ответ клиенту или внутренняя заметка. Режимы различаются цветом токена,
// подписью поля и текстом кнопки. Черновик на сервере через секунду после ввода и при уходе со страницы
// (FR-AG-21, UX-A-07). Если обращение изменили, пока агент писал, ответ не уходит (FR-AG-12).

export type ComposerLabels = {
  form: string;
  mode: string;
  modeReply: string;
  modeNote: string;
  replyField: string;
  noteField: string;
  noteHint: string;
  waitForClient: string;
  send: string;
  saveNote: string;
  sendNext: string;
  busy: string;
  draftSaved: string;
  errors: Record<string, string>;
  changed: ChangedLabels;
  files: FilePickerLabels;
  templates: { open: string; list: string; empty: string; fallback: string };
};

type Props = {
  number: number;
  version: string;
  draft: { body: string; internal: boolean } | null;
  accept: string;
  maxFiles: number;
  /** Включённые шаблоны, уже на языке обращения (FR-AG-06). */
  templates: PickerTemplate[];
  /** Очередь и сортировка, из которых открыто обращение: для "Отправить и к следующему" (FR-AG-17). */
  queue: string;
  sort: string;
  labels: ComposerLabels;
};

/** События страницы для поля ответа: перейти в режим и в поле (клавиши R, N), вставить шаблон (палитра). */
export const COMPOSER_FOCUS = 'hub:composer-focus';
export const COMPOSER_INSERT = 'hub:composer-insert';

const DRAFT_DELAY_MS = 1000;
const INITIAL: ComposerState = { status: 'idle' };
const noop = () => () => undefined;

export function Composer({ number, version, draft, accept, maxFiles, templates, queue, sort, labels }: Props) {
  const router = useRouter();
  const [state, action, pending] = useActionState(staffMessageAction, INITIAL);
  const [internal, setInternal] = useState(draft?.internal ?? false);
  const [body, setBody] = useState(draft?.body ?? '');
  const [uploading, setUploading] = useState(false);
  // Страница ожила (скрипты загружены): по отметке data-ready браузерные тесты ждут готовности формы.
  const ready = useSyncExternalStore(noop, () => true, () => false);
  const [saved, setSaved] = useState<'idle' | 'saved'>('idle');
  const saving = useRef<{ body: string; internal: boolean } | null>(null);
  const extra = useMemo(() => ({ number }), [number]);
  const field = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  // "/" в начале слова открывает шаблоны (UX-A-05): откуда начинается код и что набрано.
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [fallbackNote, setFallbackNote] = useState(false);
  const found = slash ? filterTemplates(templates, slash.query) : [];

  const onBodyChange = (value: string, caret: number) => {
    setBody(value);
    const next = slashQuery(value, caret);
    setSlash(next);
    if (next?.query !== slash?.query) setActive(0);
    window.dispatchEvent(new Event(TYPING_EVENT));
  };

  /** Вставить шаблон вместо набранного "/код": текст на языке обращения, агент правит его дальше. */
  const pick = (template: PickerTemplate) => {
    const el = field.current;
    if (!slash || !el) return;
    const caret = el.selectionStart ?? body.length;
    const next = `${body.slice(0, slash.start)}${template.text}${body.slice(caret)}`;
    const at = slash.start + template.text.length;
    setBody(next);
    setSlash(null);
    setFallbackNote(template.fallback);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  /** Кнопка "Шаблон": ставит "/" у каретки и открывает список. */
  const openTemplates = () => {
    const el = field.current;
    if (!el) return;
    const caret = el.selectionStart ?? body.length;
    const before = body.slice(0, caret);
    const insert = before === '' || /\s$/.test(before) ? '/' : ' /';
    const next = `${before}${insert}${body.slice(caret)}`;
    onBodyChange(next, caret + insert.length);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret + insert.length, caret + insert.length);
    });
  };

  // Черновик через секунду после последнего ввода. Первый показ ничего не сохраняет.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaved('idle');
    saving.current = { body, internal };
    const timer = window.setTimeout(() => {
      saving.current = null;
      saveDraftAction({ number, body, internal })
        .then((result) => result.ok && setSaved('saved'))
        .catch(() => undefined);
    }, DRAFT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [number, body, internal]);

  // Уход со страницы: несохранённый черновик уходит сразу.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== 'hidden' || !saving.current) return;
      const pendingDraft = saving.current;
      saving.current = null;
      void saveDraftAction({ number, ...pendingDraft });
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [number]);

  /** Показать изменения: текст сохраняется в черновик, страница перечитывается. */
  const showChanges = async () => {
    saving.current = null;
    await saveDraftAction({ number, body, internal }).catch(() => undefined);
    router.refresh();
  };

  // Клавиши R и N и вставка шаблона из палитры (UX-A-02, UX-A-17).
  useEffect(() => {
    const onFocus = (event: Event) => {
      setInternal((event as CustomEvent<string>).detail === 'note');
      requestAnimationFrame(() => field.current?.focus());
    };
    const onInsert = (event: Event) => {
      const { text, fallback } = (event as CustomEvent<{ text: string; fallback: boolean }>).detail;
      const el = field.current;
      const caret = el?.selectionStart ?? body.length;
      setBody(`${body.slice(0, caret)}${text}${body.slice(caret)}`);
      setFallbackNote(fallback);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(caret + text.length, caret + text.length);
      });
    };
    window.addEventListener(COMPOSER_FOCUS, onFocus);
    window.addEventListener(COMPOSER_INSERT, onInsert);
    return () => {
      window.removeEventListener(COMPOSER_FOCUS, onFocus);
      window.removeEventListener(COMPOSER_INSERT, onInsert);
    };
  }, [body]);
  // Ctrl+Enter отправляет, Ctrl+Shift+Enter отправляет и открывает следующее обращение очереди (FR-AG-17).
  const canSend = body.trim() !== '' && !pending && !uploading;
  useHotkey('form.complete', useCallback(() => formRef.current?.requestSubmit(), []), canSend);
  useHotkey('reply.sendNext', useCallback(() => formRef.current?.requestSubmit(nextRef.current), []), canSend);

  const error = state.status === 'error' ? (labels.errors[state.code] ?? labels.errors.other) : null;
  const fieldLabel = internal ? labels.noteField : labels.replyField;
  return (
    <form
      ref={formRef}
      action={action}
      aria-label={labels.form}
      className={cn('flex flex-col gap-3 rounded-card border p-4', internal ? 'border-warning bg-warning-bg' : 'border-border bg-card')}
      data-mode={internal ? 'note' : 'reply'}
      data-ready={ready ? '' : undefined}
    >
      <input type="hidden" name="number" value={number} />
      <input type="hidden" name="seenVersion" value={version} />
      <input type="hidden" name="internal" value={internal ? '1' : '0'} />
      <input type="hidden" name="queue" value={queue} />
      <input type="hidden" name="sort" value={sort} />
      <RadioGroup
        name="mode"
        legend={labels.mode}
        options={[
          { value: 'reply', label: labels.modeReply },
          { value: 'note', label: labels.modeNote },
        ]}
        value={internal ? 'note' : 'reply'}
        onChange={(value) => setInternal(value === 'note')}
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {state.status === 'changed' && <ChangedWarning changed={state.changed} version={state.version} labels={labels.changed} onShow={showChanges} />}
      <Label htmlFor="composer-body">{fieldLabel}</Label>
      <Textarea
        id="composer-body"
        name="body"
        required
        maxLength={20000}
        ref={field}
        value={body}
        onChange={(event) => onBodyChange(event.target.value, event.target.selectionStart)}
        onKeyDown={(event) => {
          if (!slash || found.length === 0) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length);
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            const template = found[active];
            if (!template) return;
            event.preventDefault();
            pick(template);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setSlash(null);
          }
        }}
        onBlur={() => setSlash(null)}
        className="min-h-24 bg-card"
        aria-describedby={internal ? 'composer-note-hint' : undefined}
        aria-activedescendant={slash && found[active] ? `composer-templates-${found[active].shortcut}` : undefined}
      />
      {slash && <TemplatePicker id="composer-templates" items={found} active={active} label={labels.templates.list} empty={labels.templates.empty} onPick={pick} />}
      {fallbackNote && <p className="text-sm text-muted-foreground">{labels.templates.fallback}</p>}
      {internal && (
        <p id="composer-note-hint" className="text-sm text-muted-foreground">
          {labels.noteHint}
        </p>
      )}
      {templates.length > 0 && (
        <Button type="button" variant="secondary" size="small" className="self-start" onClick={openTemplates}>
          {labels.templates.open}
        </Button>
      )}
      <FilePicker accept={accept} maxFiles={maxFiles} labels={labels.files} onBusyChange={setUploading} presignExtra={extra} />
      {!internal && (
        <label className="inline-flex min-h-control items-center gap-3 text-sm">
          <input type="checkbox" name="waitForClient" className="size-5 accent-primary" />
          {labels.waitForClient}
        </label>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {uploading && <span className="text-sm text-muted-foreground">{labels.busy}</span>}
        {saved === 'saved' && (
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {labels.draftSaved}
          </span>
        )}
        <Button ref={nextRef} type="submit" name="next" value="1" variant="secondary" disabled={pending || uploading}>
          {labels.sendNext}
        </Button>
        <Button type="submit" disabled={pending || uploading}>
          {internal ? labels.saveNote : labels.send}
        </Button>
      </div>
    </form>
  );
}
