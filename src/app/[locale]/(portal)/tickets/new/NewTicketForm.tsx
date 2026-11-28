'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { titleFromDescription } from '@/lib/subject';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FilePicker, type FilePickerLabels } from '@/ui/components/file-picker';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { RadioGroup, type RadioOption } from '@/ui/components/radio-group';
import { Textarea } from '@/ui/components/textarea';
import { browserDrafts, browserSession, clearDraft, type Draft, draftKey, forgetSent, rememberSent, saveDraft, useDraft } from '@/ui/drafts';
import { submitKept } from '@/ui/submit-kept';
import { handoffDescription, takeBrowserHandoff, type WidgetHandoff } from '@/ui/widget/handoff';
import { createTicketAction, type NewTicketState, reportAffectedAction, type SuggestResult } from './actions';
import { KnownProblemBanner } from '@/ui/components/KnownProblemBanner';
import { AnnouncementBanner, type AnnouncementTone } from '@/ui/components/AnnouncementBanner';
import { ModulePicker } from './ModulePicker';
import { Select } from '@/ui/components/select';
import { type SuggestLabels, Suggestions } from './Suggestions';

// Форма нового обращения (ТЗ 8.3, FR-TK-02): описание, тема из описания, тип, модуль, влияние, видимость, файлы.
// Черновик сохраняется на устройстве (UX-C-02), ошибка показывается у поля, введённое не теряется (UX-C-10).
// Под описанием подсказка решений (план M5, задача 10): пока она показана, остальные поля свёрнуты и раскрываются
// после "Не помогло" (экран 8.3); без подсказок поля видны сразу. Возврат со страницы решения после "Не помогло"
// открывает форму с раскрытыми полями и описанием из черновика (FR-SOL-11).
// Режим B виджета (план M6, задача 8): форма, открытая загрузчиком с #widget=1&hints=..., подставляет ошибку Smartup в
// пустое описание и модуль по коду, а признак виджета и подсказки уходят телом формы, не адресом (решения 11, 12).
// Известная проблема (план M5c, решение 13): если сигнатура текста совпала с активной показанной проблемой, над полями
// баннер "Мы знаем об этой проблеме" с кнопкой "Меня это тоже затронуло"; форма остаётся ниже: клиент мог прийти не с
// этой ошибкой.

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
  fromWidget: string;
  hours: string;
  submit: string;
  /** "Это предложение по улучшению? Предложите идею" (FR-TK-01, план M7, задача 2). */
  ideaLink: string;
  ideaLinkAction: string;
  busy: string;
  errors: Record<string, string>;
  files: FilePickerLabels;
  suggest: SuggestLabels & { sendAnyway: string };
  /** Баннер известной проблемы над формой (план M5c, решение 13). Подстановки {status}. */
  problem: { heading: string; status: string; statuses: Record<string, string>; workaround: string; open: string; affected: string; affectedHint: string };
};

const INITIAL: NewTicketState = { error: null, field: null };

/** Объявление модуля над формой (решение 24 плана M5c): показывается, когда выбран его модуль. */
export type FormAnnouncement = { id: string; moduleId: string; kind: AnnouncementTone; kindLabel: string; title: string; body: string };

type FormProps = {
  userId: string;
  announcements: FormAnnouncement[];
  /** Сессия формы для исходов подсказки: выдаёт сервер (решение 12). */
  sessionId: string;
  /** Поля раскрыты сразу: возврат после "Не помогло". */
  initialOpen: boolean;
  relatedNumber: number | null;
  modules: RadioOption[];
  /** Код модуля из справочника по идентификатору: подсказка режима B называет модуль кодом. */
  moduleCodes: Record<string, string>;
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
  // Подсказки режима B забираются один раз после гидратации: фрагмент убирается из адреса, запись из sessionStorage.
  const [handoff, setHandoff] = useState<WidgetHandoff | null | undefined>(undefined);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- хранилище вкладки есть только в браузере, а запись забирается один раз
    setHandoff(takeBrowserHandoff());
  }, []);
  const ready = hydrated && handoff !== undefined;
  // После гидратации поля пересоздаются уже с черновиком и подсказками.
  return <Fields key={ready ? 'client' : 'server'} {...props} draftKey={key} hydrated={ready} draft={draft} handoff={handoff ?? null} />;
}

/** Подсказки режима B в поля контекста обращения: те же имена, что у обращения из панели виджета. */
const contextOf = ({ hints }: WidgetHandoff) => ({
  moduleCode: hints.module,
  screen: hints.form,
  version: hints.appVersion,
  errorCode: hints.errorCode,
  errorText: hints.errorText,
});

const pick = (value: string | undefined, options: RadioOption[], fallback: string) => (value && options.some((o) => o.value === value) ? value : fallback);

function Fields({
  userId,
  announcements,
  sessionId,
  initialOpen,
  relatedNumber,
  modules,
  moduleCodes,
  types,
  impacts,
  visibilities,
  accept,
  maxFiles,
  labels,
  draftKey: key,
  hydrated,
  draft,
  handoff,
}: FormProps & { draftKey: string; hydrated: boolean; draft: Draft | null; handoff: WidgetHandoff | null }) {
  const [state, action, pending] = useActionState(createTicketAction, INITIAL);
  const hints = handoff?.hints;
  // Черновик клиента важнее: ошибка подставляется только в пустое описание, контекст уходит в любом случае.
  const [description, setDescription] = useState(draft?.description || (hints ? handoffDescription(hints) : ''));
  const [title, setTitle] = useState(draft?.title ?? '');
  const [titleEdited, setTitleEdited] = useState(Boolean(draft?.title));
  const [type, setType] = useState(pick(draft?.type, types, types[0]?.value ?? 'bug'));
  const [impact, setImpact] = useState(pick(draft?.impact, impacts, 'major'));
  const [visibility, setVisibility] = useState(pick(draft?.visibility, visibilities, 'org'));
  const [moduleId, setModuleId] = useState(() => (hints?.module ? (Object.keys(moduleCodes).find((id) => moduleCodes[id] === hints.module) ?? '') : ''));
  const [uploading, setUploading] = useState(false);
  const [open, setOpen] = useState(initialOpen);
  const [suggested, setSuggested] = useState(false);
  const [problem, setProblem] = useState<SuggestResult['knownProblem']>(null);
  // Поля свёрнуты, пока показана подсказка и клиент не нажал "Не помогло". Ошибка отправки поля раскрывает.
  const collapsed = suggested && !open && !state.error;

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

  // Ошибка поля снимается, как только клиент начал её исправлять (проверка интерфейса, U4): запоминается ответ
  // сервера, который клиент уже увидел и правит.
  const [answered, setAnswered] = useState<NewTicketState | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const formErrorRef = useRef<HTMLDivElement>(null);
  // После ответа сервера с ошибкой (U3; UX-C-10) фокус встаёт на поле с ошибкой или на общее сообщение, и оно
  // прокручивается в видимую часть экрана.
  useEffect(() => {
    if (!state.error) return;
    const target = state.field === 'description' ? descriptionRef.current : formErrorRef.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center' });
  }, [state]);

  const subject = titleEdited ? title : titleFromDescription(description);
  const descriptionError = state.field === 'description' && answered !== state ? labels.errors.description : undefined;
  const formError = state.error && state.field === null ? (labels.errors[state.error] ?? labels.errors.invalid_input) : null;

  return (
    <form
      action={action}
      // Черновик удаляет страница обращения после успешной отправки, и только если ушёл именно он: обрыв сети
      // его не теряет, правка во время отправки сохраняется.
      onSubmit={(event) => {
        rememberSent(browserSession(), key, current);
        // Без сброса формы после ответа сервера: выбранные влияние, тип и видимость остаются (проверка интерфейса, U5).
        submitKept(event, action);
      }}
      className="flex flex-col gap-5"
      noValidate
      // Форма готова, когда черновик уже подставлен: до этого введённое поле пересоздаст с черновиком.
      data-ready={hydrated ? '' : undefined}
    >
      {labels.related && <Alert>{labels.related}</Alert>}
      {relatedNumber && <input type="hidden" name="relatedNumber" value={relatedNumber} />}
      {handoff && (
        <>
          <div data-testid="from-widget">
            <Alert>{labels.fromWidget}</Alert>
          </div>
          <input type="hidden" name="widget" value="1" />
          <input type="hidden" name="context" value={JSON.stringify(contextOf(handoff))} />
        </>
      )}
      {formError && (
        <div ref={formErrorRef} tabIndex={-1} className="rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Alert tone="danger">{formError}</Alert>
        </div>
      )}
      {announcements
        .filter((a) => moduleId !== '' && a.moduleId === moduleId)
        .map((a) => (
          <AnnouncementBanner key={a.id} kind={a.kind} kindLabel={a.kindLabel} title={a.title} body={a.body} />
        ))}
      {problem && (
        <KnownProblemBanner
          testId="known-problem-banner"
          heading={labels.problem.heading}
          title={problem.publicTitle}
          status={labels.problem.status.replace('{status}', labels.problem.statuses[problem.status] ?? '')}
          body={problem.publicBody}
          workaround={
            problem.workaround
              ? {
                  label: labels.problem.workaround,
                  link: (
                    <Link href={`/help/a/${problem.workaround.number}-${problem.workaround.slug}`} className="text-link underline underline-offset-2">
                      {problem.workaround.title}
                    </Link>
                  ),
                }
              : null
          }
        >
          {/* Кнопка отправляет эту же форму другим действием: описание из поля уходит в обращение. */}
          <input type="hidden" name="problemNumber" value={problem.number} />
          <Button type="submit" formAction={reportAffectedAction} data-own-action className="tablet:self-start">
            {labels.problem.affected}
          </Button>
          <p className="text-sm">{labels.problem.affectedHint}</p>
        </KnownProblemBanner>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="field-description">{labels.description}</Label>
        <Textarea
          id="field-description"
          name="description"
          required
          maxLength={20000}
          ref={descriptionRef}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            if (state.field === 'description') setAnswered(state);
          }}
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
        <p className="text-sm text-muted-foreground">
          {labels.ideaLink}{' '}
          {/* Ссылка внутри текста подчёркнута всегда: её отличает не только цвет (axe, link-in-text-block). */}
          <Link href="/ideas/new" className="text-link underline underline-offset-2">
            {labels.ideaLinkAction}
          </Link>
        </p>
      </div>

      <input type="hidden" name="suggestSession" value={sessionId} />
      <Suggestions
        text={description}
        moduleId={moduleId}
        sessionId={sessionId}
        open={open}
        labels={labels.suggest}
        onChange={setSuggested}
        onNotHelped={() => setOpen(true)}
        onProblem={setProblem}
      />

      {/* Клиент уже заполняет поля: подсказка, пришедшая позже, их не сворачивает. */}
      <div hidden={collapsed} onFocus={() => setOpen(true)} className="flex flex-col gap-5">
      {suggested && <h2 className="font-semibold">{labels.suggest.sendAnyway}</h2>}
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
      </div>
    </form>
  );
}
