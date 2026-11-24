'use client';

import { Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/ui/components/button';
import { Input } from '@/ui/components/input';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { type ActionDraft, type Issue, type IssueCode, issuesAt } from './rule-draft';

// Строки действий: общая часть редактора правила автоматизации и редактора макроса (FR-AUTO-04, UX-A-16: макрос
// собирается из того же набора действий, что и правило). Вид действия и его значение выбираются из списков; какие
// действия предложить, решает страница списком options.actions. Проверяет строки только сервер: отказ возвращается
// с путём actions.<номер> и показывается у строки.

export type Option = { value: string; label: string };

export type ActionRowsOptions = {
  actions: Option[];
  /** Значения действий по виду действия. */
  actionValues: Record<string, Option[]>;
  /** Получатели действия "уведомить". У макроса такого действия нет. */
  notify?: { oncall: Option; roles: Option[]; staff: Option[] };
};

export type ActionRowsLabels = {
  noActions: string;
  addAction: string;
  /** Шаблоны с {n}: номер строки. */
  actionRow: string;
  removeAction: string;
  value: string;
  action: string;
  pick: string;
  unknown: string;
  actionValues: Record<string, string>;
  targets?: { roles: string; staff: string };
  issues: Record<IssueCode, string>;
};

export const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
/** Действия, у которых значение выбирается из списка actionValues. */
const PICK_ACTIONS = new Set(['set_queue', 'assign', 'set_priority', 'add_tag', 'remove_tag', 'reply_template', 'set_status', 'webhook']);

/** Ошибки строки или поля: объявляются программой экранного доступа сразу. fallback: текст для общего отказа поля "название". */
export function RowIssues<K extends string = never>({ id, codes, labels, fallback }: { id: string; codes: IssueCode[]; labels: { issues: Record<IssueCode | K, string> }; fallback?: K }) {
  if (codes.length === 0) return null;
  const issues: Record<string, string> = labels.issues;
  return (
    <p id={id} role="alert" data-issue className="text-sm text-destructive-on-bg">
      {codes.map((code) => (code === 'invalid' && fallback ? issues[fallback] : issues[code])).join(' ')}
    </p>
  );
}

type Props = {
  rows: ActionDraft[];
  onChange: (rows: ActionDraft[]) => void;
  options: ActionRowsOptions;
  labels: ActionRowsLabels;
  /** Отказы сервера: к строке относятся пути actions.<номер>. */
  issues: readonly Issue[];
};

export function ActionRows({ rows, onChange, options, labels, issues }: Props) {
  /** Ключи строк: следующий свободный номер. Только что добавленная строка получает фокус. */
  const nextKey = useRef(0);
  const [added, setAdded] = useState<number | null>(null);
  const patch = (key: number, change: Partial<ActionDraft>) => onChange(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const add = () => {
    const key = Math.max(nextKey.current, ...rows.map((row) => row.key + 1), 1);
    nextKey.current = key + 1;
    setAdded(key);
    onChange([...rows, { key, action: options.actions[0]?.value ?? 'set_queue', value: '', text: '' }]);
  };
  return (
    <>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{labels.noActions}</p>}
      <ol className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const rowName = fill(labels.actionRow, { n: index + 1 });
          const codes = issuesAt(issues, `actions.${index}`);
          const errorId = `rule-action-${row.key}-error`;
          const describedBy = codes.length > 0 ? errorId : undefined;
          const invalid = codes.length > 0 || undefined;
          const valueLabel = `${rowName}: ${labels.actionValues[row.action] ?? labels.value}`;
          const list = options.actionValues[row.action] ?? [];
          const known = options.actions.some((option) => option.value === row.action);
          const notify = options.notify;
          return (
            <li key={row.key} data-action={index + 1} className="flex flex-col gap-2 rounded-control border border-border p-3">
              <div className="flex flex-wrap items-start gap-2">
                <span className="inline-flex h-field items-center text-sm font-semibold text-secondary-foreground" aria-hidden>
                  {index + 1}.
                </span>
                <Select
                  aria-label={`${rowName}: ${labels.action}`}
                  value={row.action}
                  autoFocus={added === row.key}
                  className="min-w-0 flex-1 basis-56"
                  onChange={(event) => patch(row.key, { action: event.target.value, value: '', text: '' })}
                >
                  {!known && <option value={row.action}>{labels.unknown}</option>}
                  {options.actions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <Button variant="ghost" size="small" aria-label={fill(labels.removeAction, { n: index + 1 })} onClick={() => onChange(rows.filter((item) => item.key !== row.key))}>
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              {PICK_ACTIONS.has(row.action) && (
                <Select aria-label={valueLabel} value={row.value} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => patch(row.key, { value: event.target.value })}>
                  <option value="">{labels.pick}</option>
                  {row.value !== '' && !list.some((option) => option.value === row.value) && <option value={row.value}>{labels.unknown}</option>}
                  {list.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
              {row.action === 'notify' && notify && (
                <Select aria-label={valueLabel} value={row.value} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => patch(row.key, { value: event.target.value })}>
                  <option value="">{labels.pick}</option>
                  {row.value.startsWith('user:') && !notify.staff.some((option) => option.value === row.value) && <option value={row.value}>{labels.unknown}</option>}
                  <option value={notify.oncall.value}>{notify.oncall.label}</option>
                  <optgroup label={labels.targets?.roles}>
                    {notify.roles.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={labels.targets?.staff}>
                    {notify.staff.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                </Select>
              )}
              {row.action === 'snooze' && (
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={720}
                  aria-label={valueLabel}
                  placeholder={labels.actionValues.snooze}
                  value={row.value}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(event) => patch(row.key, { value: event.target.value })}
                />
              )}
              {row.action === 'add_note' && (
                <Textarea
                  aria-label={valueLabel}
                  placeholder={labels.actionValues.add_note}
                  value={row.text}
                  maxLength={2000}
                  className="min-h-20"
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(event) => patch(row.key, { text: event.target.value })}
                />
              )}
              <RowIssues id={errorId} codes={codes} labels={labels} />
            </li>
          );
        })}
      </ol>
      <Button variant="secondary" size="small" className="self-start" onClick={add}>
        <Plus className="size-4" aria-hidden />
        {labels.addAction}
      </Button>
    </>
  );
}
