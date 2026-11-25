'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FilePicker, type FilePickerLabels } from '@/ui/components/file-picker';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { browserDrafts, browserSession, clearDraft, type Draft, draftKey, forgetSent, rememberSent, saveDraft, useDraft } from '@/ui/drafts';
import { type NewIdeaState, submitIdeaAction } from './actions';

// Форма новой идеи (ТЗ FR-IDEA-01, 06; план M7, задача 2): заголовок, описание, модуль, до трёх изображений, показ
// организации. Черновик на устройстве (как UX-C-02), ошибка у формы, введённое не теряется (UX-C-10). Находки проверки
// текста показываются предупреждением с кнопкой "Отправить всё равно" (решение 9).

export type NewIdeaLabels = {
  title: string;
  titleHint: string;
  body: string;
  bodyHint: string;
  module: string;
  moduleNone: string;
  showOrg: string;
  showOrgHint: string;
  submit: string;
  sendAnyway: string;
  findingsTitle: string;
  findings: Record<string, string>;
  busy: string;
  moderation: string;
  errors: Record<string, string>;
  files: FilePickerLabels;
};

const INITIAL: NewIdeaState = { error: null, findings: null };
const SCOPE = 'new-idea';
/** Цель загрузки: обработчик /api/uploads выбирает по ней таблицу вложений идей (решение 10). */
const UPLOAD_EXTRA = { purpose: 'idea' };

type Props = {
  userId: string;
  modules: { value: string; label: string }[];
  accept: string;
  maxFiles: number;
  titleMax: number;
  bodyMax: number;
  labels: NewIdeaLabels;
};

export function NewIdeaForm(props: Props) {
  const key = useMemo(() => draftKey(props.userId, SCOPE), [props.userId]);
  const { hydrated, draft } = useDraft(key);
  // После гидратации поля пересоздаются уже с черновиком.
  return <Fields key={hydrated ? 'client' : 'server'} {...props} draftKey={key} hydrated={hydrated} draft={draft} />;
}

function Fields({ modules, accept, maxFiles, titleMax, bodyMax, labels, draftKey: key, hydrated, draft }: Props & { draftKey: string; hydrated: boolean; draft: Draft | null }) {
  const [state, action, pending] = useActionState(submitIdeaAction, INITIAL);
  const [title, setTitle] = useState(draft?.title ?? '');
  const [body, setBody] = useState(draft?.body ?? '');
  const [moduleId, setModuleId] = useState(draft?.moduleId ?? '');
  const [uploading, setUploading] = useState(false);
  // Предупреждение относится к отправленному тексту: правка текста его снимает.
  const [warnedFor, setWarnedFor] = useState<string | null>(null);
  const current = useMemo<Draft>(() => ({ title, body, moduleId }), [title, body, moduleId]);

  useEffect(() => {
    if (!hydrated) return;
    if (title.trim() === '' && body.trim() === '') clearDraft(browserDrafts(), key);
    else saveDraft(browserDrafts(), key, current);
  }, [hydrated, key, current, title, body]);
  useEffect(() => {
    if (state.error || state.findings) forgetSent(browserSession(), key);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ответ действия приходит один раз, предупреждение привязывается к отправленному тексту
    if (state.findings) setWarnedFor(`${title}\n${body}`);
    // Текст в зависимостях не нужен: отметка ставится только на новый ответ действия.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, key]);

  const warned = state.findings && warnedFor === `${title}\n${body}` ? state.findings : null;
  const formError = state.error ? (labels.errors[state.error] ?? labels.errors.invalid_input) : null;

  return (
    <form action={action} onSubmit={() => rememberSent(browserSession(), key, current)} className="flex flex-col gap-5" noValidate data-ready={hydrated ? '' : undefined}>
      <Alert>{labels.moderation}</Alert>
      {formError && <Alert tone="danger">{formError}</Alert>}

      <div className="flex flex-col gap-1">
        <Label htmlFor="idea-title">{labels.title}</Label>
        <Input id="idea-title" name="title" required maxLength={titleMax} value={title} onChange={(event) => setTitle(event.target.value)} aria-describedby="idea-title-hint" />
        <p id="idea-title-hint" className="text-sm text-muted-foreground">
          {labels.titleHint}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="idea-body">{labels.body}</Label>
        <Textarea id="idea-body" name="body" required maxLength={bodyMax} value={body} onChange={(event) => setBody(event.target.value)} aria-describedby="idea-body-hint" />
        <p id="idea-body-hint" className="text-sm text-muted-foreground">
          {labels.bodyHint}
        </p>
      </div>

      {modules.length > 0 && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="idea-module">{labels.module}</Label>
          <Select id="idea-module" name="moduleId" value={moduleId} onChange={(event) => setModuleId(event.target.value)}>
            <option value="">{labels.moduleNone}</option>
            {modules.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      )}

      <FilePicker accept={accept} maxFiles={maxFiles} labels={labels.files} onBusyChange={setUploading} presignExtra={UPLOAD_EXTRA} />

      <div className="flex items-start gap-2">
        <input id="idea-show-org" type="checkbox" name="showOrg" className="mt-1 size-4 accent-primary" aria-describedby="idea-show-org-hint" />
        <div className="flex flex-col gap-1">
          <Label htmlFor="idea-show-org">{labels.showOrg}</Label>
          <p id="idea-show-org-hint" className="text-sm text-muted-foreground">
            {labels.showOrgHint}
          </p>
        </div>
      </div>

      {warned && (
        <div data-testid="idea-findings">
          <Alert>
            <p className="font-semibold">{labels.findingsTitle}</p>
            <ul className="list-disc ps-5">
              {warned.map((kind) => (
                <li key={kind}>{labels.findings[kind] ?? labels.findings.internal}</li>
              ))}
            </ul>
          </Alert>
          <input type="hidden" name="confirm" value="1" />
        </div>
      )}
      {uploading && <p className="text-sm text-muted-foreground">{labels.busy}</p>}
      <Button type="submit" disabled={pending || uploading} className="tablet:self-start">
        {warned ? labels.sendAnyway : labels.submit}
      </Button>
    </form>
  );
}
