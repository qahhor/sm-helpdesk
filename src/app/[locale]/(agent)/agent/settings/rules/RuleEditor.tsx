'use client';

import { Plus, X } from 'lucide-react';
import { type ReactNode, useRef, useState, useTransition } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { ActionRows, type ActionRowsLabels, type ActionRowsOptions, fill, type Option, RowIssues } from './ActionRows';
import { type DryRunView, dryRunRuleAction, type RuleFormState, saveRuleAction, searchRuleOrgsAction } from './actions';
import { type ConditionDraft, FIELD_OPS, type Issue, type IssueCode, issuesAt, kindOf, otherIssues, payloadOf, type RuleDraft } from './rule-draft';

// Редактор правила автоматизации (FR-AUTO-01, 08; экран "Правило автоматизации" раздела 8.12 ТЗ). Правило читается
// как предложение: КОГДА событие, ЕСЛИ условия, ТО действия. Правило хранится в состоянии компонента и уходит на
// сервер одной строкой JSON; проверяет его только сервер, отказ возвращается с путём до строки. Значения выбираются
// из списков, идентификаторы руками не вводятся. Тексты приходят свойствами: каталог сообщений в браузер не идёт.

export type { Option } from './ActionRows';

export type RuleEditorOptions = ActionRowsOptions & {
  events: Option[];
  fields: Option[];
  /** Значения условий по полю: списки и теги. У организаций здесь названия уже выбранных. */
  values: Record<string, Option[]>;
  workTime: Option[];
};

export type RuleEditorLabels = ActionRowsLabels & {
  name: string;
  nameHint: string;
  when: string;
  event: string;
  hours: string;
  hoursHint: string;
  if: string;
  match: string;
  matchAll: string;
  matchAny: string;
  noConditions: string;
  then: string;
  addCondition: string;
  /** Шаблоны с {n}: номер строки. */
  conditionRow: string;
  removeCondition: string;
  field: string;
  operator: string;
  addValue: string;
  add: string;
  /** Шаблон с {name}. */
  removeValue: string;
  words: string;
  hoursValue: string;
  rating: string;
  orgSearch: string;
  orgFind: string;
  orgEmpty: string;
  /** Шаблон с {name}. */
  orgAdd: string;
  stop: string;
  save: string;
  newDisabled: string;
  reauth: string;
  ops: Record<string, string>;
  issues: Record<IssueCode | 'name' | 'actions' | 'conditions' | 'general', string>;
  dry: { title: string; scopeHint: string; run: string; count: string; none: string; matches: string; would: string; safe: string; more: string };
};

type Props = {
  initial: RuleDraft;
  options: RuleEditorOptions;
  labels: RuleEditorLabels;
  /** Вход заново с возвратом на эту страницу: для ошибки "вход не свежий". */
  reauthHref: string;
  /** Состояние правила под кнопкой "Сохранить": метка для существующего, пояснение для нового. */
  state: ReactNode;
  /** Предустановленное правило: событие не меняется, под полем это пояснение. */
  eventLock?: string | null;
};

const RATINGS = ['1', '2', '3', '4', '5'];

/** Выбранные значения метками, у каждой кнопка "убрать". */
function Picked({ label, values, nameOf, onChange, labels }: { label: string; values: string[]; nameOf: (value: string) => string; onChange: (values: string[]) => void; labels: RuleEditorLabels }) {
  if (values.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label={label}>
      {values.map((value) => (
        <li key={value} data-picked className="inline-flex max-w-full items-center gap-1 rounded-chip bg-label-gray-bg ps-2.5 text-sm font-semibold text-label-gray-fg">
          <span className="break-all">{nameOf(value)}</span>
          <button
            type="button"
            aria-label={fill(labels.removeValue, { name: nameOf(value) })}
            onClick={() => onChange(values.filter((item) => item !== value))}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-chip outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Выбранные значения метками, список и кнопка "добавить": замена множественному выбору, удобная с клавиатуры. */
function MultiPick({
  label,
  options,
  values,
  onChange,
  labels,
  invalid,
  describedBy,
}: {
  label: string;
  options: Option[];
  values: string[];
  onChange: (values: string[]) => void;
  labels: RuleEditorLabels;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  // Значение сначала выбирается в списке, затем добавляется кнопкой: стрелки в закрытом списке ничего не добавляют сами.
  const [pick, setPick] = useState('');
  const left = options.filter((option) => !values.includes(option.value));
  const nameOf = (value: string) => options.find((option) => option.value === value)?.label ?? labels.unknown;
  return (
    <div className="flex flex-col gap-2">
      <Picked label={label} values={values} nameOf={nameOf} onChange={onChange} labels={labels} />
      <div className="flex flex-wrap gap-2">
        <Select aria-label={label} aria-invalid={invalid || undefined} aria-describedby={describedBy} value={pick} className="min-w-0 flex-1" onChange={(event) => setPick(event.target.value)}>
          <option value="">{labels.pick}</option>
          {left.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          aria-label={`${label}: ${labels.addValue}`}
          disabled={!left.some((option) => option.value === pick)}
          onClick={() => {
            onChange([...values, pick]);
            setPick('');
          }}
        >
          <Plus className="size-4" aria-hidden />
          {labels.add}
        </Button>
      </div>
    </div>
  );
}

/** Организации условия: поиск по названию и ИНН на сервере, найденное добавляется кнопкой. */
function OrgPick({
  label,
  known,
  values,
  onChange,
  onKnown,
  labels,
  describedBy,
}: {
  label: string;
  known: Option[];
  values: string[];
  onChange: (values: string[]) => void;
  onKnown: (found: Option[]) => void;
  labels: RuleEditorLabels;
  describedBy: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Option[] | null>(null);
  const [pending, start] = useTransition();
  const nameOf = (value: string) => known.find((option) => option.value === value)?.label ?? labels.unknown;
  const search = () =>
    start(async () => {
      const list = await searchRuleOrgsAction(query);
      onKnown(list);
      setFound(list);
    });
  return (
    <div className="flex flex-col gap-2">
      <Picked label={label} values={values} nameOf={nameOf} onChange={onChange} labels={labels} />
      <div className="flex flex-wrap gap-2">
        <Input
          type="search"
          aria-label={`${label}: ${labels.orgSearch}`}
          aria-describedby={describedBy}
          placeholder={labels.orgSearch}
          value={query}
          maxLength={100}
          className="min-w-0 flex-1"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // Enter в поле поиска ищет, а не сохраняет правило.
            event.preventDefault();
            search();
          }}
        />
        <Button variant="secondary" disabled={pending} onClick={search}>
          {labels.orgFind}
        </Button>
      </div>
      <div role="status">
        {found !== null && found.length === 0 && <p className="text-sm text-muted-foreground">{labels.orgEmpty}</p>}
        {found !== null && found.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {found
              .filter((option) => !values.includes(option.value))
              .map((option) => (
                <li key={option.value}>
                  <Button variant="secondary" size="small" aria-label={fill(labels.orgAdd, { name: option.label })} onClick={() => onChange([...values, option.value])}>
                    <Plus className="size-4" aria-hidden />
                    {option.label}
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function RuleEditor({ initial, options, labels, reauthHref, state, eventLock }: Props) {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [orgs, setOrgs] = useState<Option[]>(options.values.org ?? []);
  const [feedback, setFeedback] = useState<RuleFormState>({});
  const [dry, setDry] = useState<DryRunView | null>(null);
  const [saving, startSave] = useTransition();
  const [running, startDry] = useTransition();
  /** Ключи строк условий: следующий свободный номер. Только что добавленная строка получает фокус. */
  const nextKey = useRef(Math.max(0, ...initial.conditions.map((row) => row.key)) + 1);
  const [added, setAdded] = useState<string | null>(null);

  const issues: readonly Issue[] = feedback.issues ?? [];
  const general = otherIssues(issues, draft.conditions.length, draft.actions.length);
  const patch = (change: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...change }));
  const patchCondition = (key: number, change: Partial<ConditionDraft>) =>
    setDraft((current) => ({ ...current, conditions: current.conditions.map((row) => (row.key === key ? { ...row, ...change } : row)) }));
  const valuesOf = (field: string): Option[] => (field === 'org' ? orgs : (options.values[field] ?? []));

  const addCondition = () => {
    const key = nextKey.current++;
    setAdded(`c${key}`);
    setDraft((current) => ({ ...current, conditions: [...current.conditions, { key, field: 'priority', op: 'is', values: [], text: '' }] }));
  };
  const changeField = (key: number, field: string) => {
    const kind = kindOf(field);
    patchCondition(key, { field, op: FIELD_OPS[kind][0], values: [], text: kind === 'work' ? 'working' : '' });
  };

  const save = () =>
    startSave(async () => {
      // Успех уводит на страницу правила; сюда возвращается только отказ.
      setFeedback(await saveRuleAction(JSON.stringify(payloadOf(draft))));
    });
  const dryRun = () =>
    startDry(async () => {
      const { result, ...rest } = await dryRunRuleAction(JSON.stringify(payloadOf(draft)));
      setFeedback(rest);
      setDry(result ?? null);
    });

  const nameIssues = issuesAt(issues, 'name');
  const hoursIssues = issuesAt(issues, 'hours');
  const eventIssues = issuesAt(issues, 'event');
  const heading = 'text-sm font-semibold uppercase text-secondary-foreground';

  return (
    <form
      className="grid items-start gap-4 desktop:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Card>
        <CardContent className="flex flex-col gap-5 pt-4">
          {feedback.error && (
            <Alert tone="danger">
              {feedback.error}
              {feedback.reauth && (
                <>
                  {' '}
                  <a href={reauthHref} className="font-semibold underline">
                    {labels.reauth}
                  </a>
                </>
              )}
              {general.length > 0 && (
                <>
                  {' '}
                  {[...new Set(general.map((issue) => (issue.path === 'actions' ? labels.issues.actions : issue.path === 'conditions.items' ? labels.issues.conditions : labels.issues.general)))].join(' ')}
                </>
              )}
            </Alert>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="rule-name">{labels.name}</Label>
            <Input
              id="rule-name"
              value={draft.name}
              maxLength={120}
              aria-invalid={nameIssues.length > 0 || undefined}
              aria-describedby={nameIssues.length > 0 ? 'rule-name-hint rule-name-error' : 'rule-name-hint'}
              onChange={(event) => patch({ name: event.target.value })}
            />
            <p id="rule-name-hint" className="text-sm text-muted-foreground">
              {labels.nameHint}
            </p>
            <RowIssues id="rule-name-error" codes={nameIssues} labels={labels} fallback="name" />
          </div>

          <section aria-labelledby="rule-when" className="flex flex-col gap-2">
            <h2 id="rule-when" className={heading}>
              {labels.when}
            </h2>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
                <Label htmlFor="rule-event">{labels.event}</Label>
                <Select
                  id="rule-event"
                  value={draft.event}
                  disabled={Boolean(eventLock)}
                  aria-invalid={eventIssues.length > 0 || undefined}
                  aria-describedby={[eventLock ? 'rule-event-lock' : '', eventIssues.length > 0 ? 'rule-event-error' : ''].filter(Boolean).join(' ') || undefined}
                  onChange={(event) => patch({ event: event.target.value })}
                >
                  {options.events.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                {eventLock && (
                  <p id="rule-event-lock" className="text-sm text-muted-foreground">
                    {eventLock}
                  </p>
                )}
                <RowIssues id="rule-event-error" codes={eventIssues} labels={labels} />
              </div>
              {draft.event === 'no_activity' && (
                <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
                  <Label htmlFor="rule-hours">{labels.hours}</Label>
                  <Input
                    id="rule-hours"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={8760}
                    value={draft.hours}
                    aria-invalid={hoursIssues.length > 0 || undefined}
                    aria-describedby={hoursIssues.length > 0 ? 'rule-hours-hint rule-hours-error' : 'rule-hours-hint'}
                    onChange={(event) => patch({ hours: event.target.value })}
                  />
                  <p id="rule-hours-hint" className="text-sm text-muted-foreground">
                    {labels.hoursHint}
                  </p>
                  <RowIssues id="rule-hours-error" codes={hoursIssues} labels={labels} />
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="rule-if" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="rule-if" className={heading}>
                {labels.if}
              </h2>
              <Select aria-label={labels.match} value={draft.match} className="w-auto" onChange={(event) => patch({ match: event.target.value === 'any' ? 'any' : 'all' })}>
                <option value="all">{labels.matchAll}</option>
                <option value="any">{labels.matchAny}</option>
              </Select>
            </div>
            {draft.conditions.length === 0 && <p className="text-sm text-muted-foreground">{labels.noConditions}</p>}
            <ol className="flex flex-col gap-2">
              {draft.conditions.map((row, index) => {
                const rowName = fill(labels.conditionRow, { n: index + 1 });
                const codes = issuesAt(issues, `conditions.items.${index}`);
                const errorId = `rule-condition-${row.key}-error`;
                const describedBy = codes.length > 0 ? errorId : undefined;
                const kind = kindOf(row.field);
                const valueLabel = `${rowName}: ${labels.value}`;
                return (
                  <li key={row.key} data-condition={index + 1} className="flex flex-col gap-2 rounded-control border border-border p-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <Select
                        aria-label={`${rowName}: ${labels.field}`}
                        value={row.field}
                        autoFocus={added === `c${row.key}`}
                        className="min-w-0 flex-1 basis-40"
                        onChange={(event) => changeField(row.key, event.target.value)}
                      >
                        {options.fields.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                      <Select aria-label={`${rowName}: ${labels.operator}`} value={row.op} className="min-w-0 flex-1 basis-40" onChange={(event) => patchCondition(row.key, { op: event.target.value })}>
                        {FIELD_OPS[kind].map((op) => (
                          <option key={op} value={op}>
                            {labels.ops[op]}
                          </option>
                        ))}
                      </Select>
                      <Button variant="ghost" size="small" aria-label={fill(labels.removeCondition, { n: index + 1 })} onClick={() => patch({ conditions: draft.conditions.filter((item) => item.key !== row.key) })}>
                        <X className="size-4" aria-hidden />
                      </Button>
                    </div>
                    {row.field === 'org' ? (
                      <OrgPick
                        label={valueLabel}
                        known={orgs}
                        values={row.values}
                        labels={labels}
                        describedBy={describedBy}
                        onChange={(values) => patchCondition(row.key, { values })}
                        onKnown={(found) => setOrgs((current) => [...current, ...found.filter((option) => !current.some((item) => item.value === option.value))])}
                      />
                    ) : kind === 'list' || kind === 'tags' ? (
                      <MultiPick label={valueLabel} options={valuesOf(row.field)} values={row.values} labels={labels} invalid={codes.length > 0} describedBy={describedBy} onChange={(values) => patchCondition(row.key, { values })} />
                    ) : kind === 'words' ? (
                      <Input
                        aria-label={`${rowName}: ${labels.words}`}
                        placeholder={labels.words}
                        value={row.text}
                        maxLength={600}
                        aria-invalid={codes.length > 0 || undefined}
                        aria-describedby={describedBy}
                        onChange={(event) => patchCondition(row.key, { text: event.target.value })}
                      />
                    ) : kind === 'hours' ? (
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={8760}
                        step="any"
                        aria-label={`${rowName}: ${labels.hoursValue}`}
                        placeholder={labels.hoursValue}
                        value={row.text}
                        aria-invalid={codes.length > 0 || undefined}
                        aria-describedby={describedBy}
                        onChange={(event) => patchCondition(row.key, { text: event.target.value })}
                      />
                    ) : (
                      <Select
                        aria-label={kind === 'rating' ? `${rowName}: ${labels.rating}` : valueLabel}
                        value={row.text}
                        aria-invalid={codes.length > 0 || undefined}
                        aria-describedby={describedBy}
                        onChange={(event) => patchCondition(row.key, { text: event.target.value })}
                      >
                        {kind === 'rating' && <option value="">{labels.pick}</option>}
                        {(kind === 'rating' ? RATINGS.map((value) => ({ value, label: value })) : options.workTime).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    )}
                    <RowIssues id={errorId} codes={codes} labels={labels} />
                  </li>
                );
              })}
            </ol>
            <Button variant="secondary" size="small" className="self-start" onClick={addCondition}>
              <Plus className="size-4" aria-hidden />
              {labels.addCondition}
            </Button>
          </section>

          <section aria-labelledby="rule-then" className="flex flex-col gap-2">
            <h2 id="rule-then" className={heading}>
              {labels.then}
            </h2>
            <ActionRows rows={draft.actions} options={options} labels={labels} issues={issues} onChange={(actions) => patch({ actions })} />
          </section>

          <label className="inline-flex min-h-control items-center gap-3 text-sm">
            <input type="checkbox" checked={draft.isStop} className="size-5 shrink-0 accent-primary" onChange={(event) => patch({ isStop: event.target.checked })} />
            {labels.stop}
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-sm text-secondary-foreground">{state}</div>
            <Button type="submit" disabled={saving}>
              {labels.save}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <section aria-labelledby="rule-dry" className="flex flex-col gap-3">
            <h2 id="rule-dry" className={heading}>
              {labels.dry.title}
            </h2>
            <p className="text-sm text-secondary-foreground">{labels.dry.scopeHint}</p>
            <div role="status" data-dry-result className="flex flex-col gap-3 empty:hidden">
              {dry && (
                <>
                  <p className="text-sm text-secondary-foreground" data-dry-basis>
                    {dry.basis}
                  </p>
                  <p className="font-semibold">{fill(labels.dry.count, { count: dry.count })}</p>
                  {dry.count === 0 ? (
                    <p className="text-sm text-secondary-foreground">{labels.dry.none}</p>
                  ) : (
                    <ul className="flex flex-col gap-3" aria-label={labels.dry.matches}>
                      {dry.matches.map((match) => (
                        <li key={match.number} data-dry-match={match.number} className="flex flex-col gap-1 text-sm">
                          <span className="flex flex-wrap gap-x-3">
                            <span className="font-semibold">SUP-{match.number}</span>
                            <span>{match.priority}</span>
                            <span className="break-all">{match.orgName}</span>
                          </span>
                          <span className="text-secondary-foreground">
                            {labels.dry.would}: {match.actions.join('; ')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {dry.count > dry.matches.length && <p className="text-sm text-muted-foreground">{fill(labels.dry.more, { shown: dry.matches.length, count: dry.count })}</p>}
                </>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{labels.dry.safe}</p>
            <Button variant="secondary" className="self-start" disabled={running} onClick={dryRun}>
              {labels.dry.run}
            </Button>
          </section>
        </CardContent>
      </Card>
    </form>
  );
}
