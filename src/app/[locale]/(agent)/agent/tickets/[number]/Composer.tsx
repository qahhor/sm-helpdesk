'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FilePicker, type FilePickerLabels } from '@/ui/components/file-picker';
import { Label } from '@/ui/components/label';
import { RadioGroup } from '@/ui/components/radio-group';
import { Textarea } from '@/ui/components/textarea';
import { cn } from '@/ui/cn';
import { type ComposerState, saveDraftAction, staffMessageAction } from './actions';
import { ChangedWarning, type ChangedLabels } from './ChangedWarning';
import { TYPING_EVENT } from './PresenceBar';

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
  busy: string;
  draftSaved: string;
  errors: Record<string, string>;
  changed: ChangedLabels;
  files: FilePickerLabels;
};

type Props = {
  number: number;
  version: string;
  draft: { body: string; internal: boolean } | null;
  accept: string;
  maxFiles: number;
  labels: ComposerLabels;
};

const DRAFT_DELAY_MS = 1000;
const INITIAL: ComposerState = { status: 'idle' };
const noop = () => () => undefined;

export function Composer({ number, version, draft, accept, maxFiles, labels }: Props) {
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

  const error = state.status === 'error' ? (labels.errors[state.code] ?? labels.errors.other) : null;
  const fieldLabel = internal ? labels.noteField : labels.replyField;
  return (
    <form
      action={action}
      aria-label={labels.form}
      className={cn('flex flex-col gap-3 rounded-card border p-4', internal ? 'border-warning bg-warning-bg' : 'border-border bg-card')}
      data-mode={internal ? 'note' : 'reply'}
      data-ready={ready ? '' : undefined}
    >
      <input type="hidden" name="number" value={number} />
      <input type="hidden" name="seenVersion" value={version} />
      <input type="hidden" name="internal" value={internal ? '1' : '0'} />
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
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          window.dispatchEvent(new Event(TYPING_EVENT));
        }}
        className="min-h-24 bg-card"
        aria-describedby={internal ? 'composer-note-hint' : undefined}
      />
      {internal && (
        <p id="composer-note-hint" className="text-sm text-muted-foreground">
          {labels.noteHint}
        </p>
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
        <Button type="submit" disabled={pending || uploading}>
          {internal ? labels.saveNote : labels.send}
        </Button>
      </div>
    </form>
  );
}
