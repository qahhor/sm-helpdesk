'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { titleFromDescription } from '@/lib/subject';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FilePicker, type FilePickerLabels } from '@/ui/components/file-picker';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { RadioGroup, type RadioOption } from '@/ui/components/radio-group';
import { Textarea } from '@/ui/components/textarea';
import { browserDrafts, browserSession, clearDraft, type Draft, draftKey, forgetSent, rememberSent, saveDraft, useDraft } from '@/ui/drafts';
import { createTicketAction, type NewTicketState } from './actions';
import { ModulePicker } from './ModulePicker';
import { Select } from '@/ui/components/select';

// Форма нового обращения (ТЗ 8.3, FR-TK-02): описание, тема из описания, тип, модуль, влияние, видимость, файлы.
// Черновик сохраняется на устройстве (UX-C-02), ошибка показывается у поля, введённое не теряется (UX-C-10).

export type NewTicketLabels = {
  description: string;
  descriptionHint: string;
  subject: string;
  subjectHint: string;
  type: string;
  module: string;
  moduleNone: string;
  moduleSearch: string;
  moduleRecent: string;
  moduleAll: string;
  impact: string;
  visibility: string;
  visibilityHint: string;
  related: string;
  hours: string;
  submit: string;
  busy: string;
  errors: Record<string, string>;
  files: FilePickerLabels;
};

const INITIAL: NewTicketState = { error: null, field: null };

type FormProps = {
  userId: string;
  relatedNumber: number | null;
  modules: RadioOption[];
  types: RadioOption[];
  impacts: RadioOption[];
  visibilities: RadioOption[];
  accept: string;
  maxFiles: number;
  labels: NewTicketLabels;
};

export function NewTicketForm(props: FormProps) {
  const key = useMemo(() => draftKey(props.userId, props.relatedNumber ? `new-ticket-${props.relatedNumber}` : 'new-ticket'), [props.userId, props.relatedNumber]);
  const { hydrated, draft } = useDraft(key);
  // После гидратации поля пересоздаются уже с черновиком.
  return <Fields key={hydrated ? 'client' : 'server'} {...props} draftKey={key} hydrated={hydrated} draft={draft} />;
}

const pick = (value: string | undefined, options: RadioOption[], fallback: string) => (value && options.some((o) => o.value === value) ? value : fallback);

function Fields({
  userId,
  relatedNumber,
  modules,
  types,
  impacts,
  visibilities,
  accept,
  maxFiles,
  labels,
  draftKey: key,
  hydrated,
  draft,
}: FormProps & { draftKey: string; hydrated: boolean; draft: Draft | null }) {
  const [state, action, pending] = useActionState(createTicketAction, INITIAL);
  const [description, setDescription] = useState(draft?.description ?? '');
  const [title, setTitle] = useState(draft?.title ?? '');
  const [titleEdited, setTitleEdited] = useState(Boolean(draft?.title));
  const [type, setType] = useState(pick(draft?.type, types, types[0]?.value ?? 'bug'));
  const [impact, setImpact] = useState(pick(draft?.impact, impacts, 'major'));
  const [visibility, setVisibility] = useState(pick(draft?.visibility, visibilities, 'org'));
  const [moduleId, setModuleId] = useState('');
  const [uploading, setUploading] = useState(false);

  // Текст сохраняется при каждом изменении, в том числе после ошибки отправки. До гидратации не трогаем хранилище.
  const current = useMemo<Draft>(
    () => ({ description, title: titleEdited ? title : '', type, impact, visibility }),
    [description, title, titleEdited, type, impact, visibility],
  );
  useEffect(() => {
    if (!hydrated) return;
    // Черновик нужен, только пока есть текст: выбор полей без текста не хранится.
    if (description.trim() === '' && !(titleEdited && title.trim() !== '')) clearDraft(browserDrafts(), key);
    else saveDraft(browserDrafts(), key, current);
  }, [hydrated, key, current, description, title, titleEdited, state]);
  // Отправка не удалась: отметка отправки снимается, черновик остаётся черновиком.
  useEffect(() => {
    if (state.error) forgetSent(browserSession(), key);
  }, [state, key]);

  const subject = titleEdited ? title : titleFromDescription(description);
  const descriptionError = state.field === 'description' ? labels.errors.description : undefined;
  const formError = state.error && state.field === null ? (labels.errors[state.error] ?? labels.errors.invalid_input) : null;

  return (
    <form
      action={action}
      // Черновик удаляет страница обращения после успешной отправки, и только если ушёл именно он: обрыв сети
      // его не теряет, правка во время отправки сохраняется.
      onSubmit={() => rememberSent(browserSession(), key, current)}
      className="flex flex-col gap-5"
      noValidate
      // Форма готова, когда черновик уже подставлен: до этого введённое поле пересоздаст с черновиком.
      data-ready={hydrated ? '' : undefined}
    >
      {labels.related && <Alert>{labels.related}</Alert>}
      {relatedNumber && <input type="hidden" name="relatedNumber" value={relatedNumber} />}
      {formError && <Alert tone="danger">{formError}</Alert>}

      <div className="flex flex-col gap-1">
        <Label htmlFor="field-description">{labels.description}</Label>
        <Textarea
          id="field-description"
          name="description"
          required
          maxLength={20000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-invalid={descriptionError ? true : undefined}
          aria-describedby={descriptionError ? 'field-description-hint field-description-error' : 'field-description-hint'}
        />
        <p id="field-description-hint" className="text-sm text-muted-foreground">
          {labels.descriptionHint}
        </p>
        {descriptionError && (
          <p id="field-description-error" className="text-sm text-destructive-on-bg">
            {descriptionError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="field-title">{labels.subject}</Label>
        <Input
          id="field-title"
          name="title"
          maxLength={200}
          value={subject}
          onChange={(event) => {
            setTitle(event.target.value);
            setTitleEdited(true);
          }}
          aria-describedby="field-title-hint"
        />
        <p id="field-title-hint" className="text-sm text-muted-foreground">
          {labels.subjectHint}
        </p>
      </div>

      <RadioGroup name="type" legend={labels.type} options={types} value={type} onChange={setType} />

      {modules.length > 0 && (
        <ModulePicker
          userId={userId}
          modules={modules}
          value={moduleId}
          onChange={setModuleId}
          labels={{ module: labels.module, none: labels.moduleNone, search: labels.moduleSearch, recent: labels.moduleRecent, all: labels.moduleAll }}
        />
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="field-impact">{labels.impact}</Label>
        <Select id="field-impact" name="impact" value={impact} onChange={(event) => setImpact(event.target.value)}>
          {impacts.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      <RadioGroup name="visibility" legend={labels.visibility} options={visibilities} value={visibility} onChange={setVisibility} hint={labels.visibilityHint} />

      <FilePicker accept={accept} maxFiles={maxFiles} labels={labels.files} onBusyChange={setUploading} />

      <p className="text-sm text-muted-foreground">{labels.hours}</p>
      {uploading && <p className="text-sm text-muted-foreground">{labels.busy}</p>}
      <Button type="submit" disabled={pending || uploading} className="tablet:self-start">
        {labels.submit}
      </Button>
    </form>
  );
}
