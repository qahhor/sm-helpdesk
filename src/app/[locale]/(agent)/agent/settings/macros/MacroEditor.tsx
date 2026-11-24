'use client';

import { useState, useTransition } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { ActionRows, type ActionRowsLabels, type ActionRowsOptions, RowIssues } from '../rules/ActionRows';
import { type ActionDraft, actionsPayload, type IssueCode, issuesAt } from '../rules/rule-draft';
import { type MacroFormState, saveMacroAction } from './actions';

// Редактор макроса (FR-AG-15, UX-A-16): название и действия из того же набора, что у правил автоматизации. Строки
// действий общие с редактором правила (ActionRows). Макрос уходит на сервер одной строкой JSON; проверяет его только
// сервер, отказ возвращается с путём до строки. Тексты приходят свойствами.

export type MacroDraft = { macroId?: string; name: string; isEnabled: boolean; actions: ActionDraft[] };

export type MacroEditorLabels = ActionRowsLabels & {
  name: string;
  nameHint: string;
  actionsTitle: string;
  actionsHint: string;
  enabled: string;
  save: string;
  reauth: string;
  issues: Record<IssueCode | 'name' | 'actions', string>;
};

export function MacroEditor({ initial, options, labels, reauthHref }: { initial: MacroDraft; options: ActionRowsOptions; labels: MacroEditorLabels; reauthHref: string }) {
  const [draft, setDraft] = useState<MacroDraft>(initial);
  const [feedback, setFeedback] = useState<MacroFormState>({});
  const [saving, startSave] = useTransition();
  const issues = feedback.issues ?? [];
  const nameIssues = issuesAt(issues, 'name');
  // Отказ списка действий целиком: ни одного действия или больше десяти.
  const listIssue = issues.some((issue) => issue.path === 'actions');
  const save = () =>
    startSave(async () => {
      // Успех уводит на страницу макроса; сюда возвращается только отказ.
      setFeedback(await saveMacroAction(JSON.stringify({ ...(draft.macroId ? { macroId: draft.macroId } : {}), name: draft.name, isEnabled: draft.isEnabled, actions: actionsPayload(draft.actions) })));
    });
  return (
    <form
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
              {listIssue && <> {labels.issues.actions}</>}
            </Alert>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor="macro-name">{labels.name}</Label>
            <Input
              id="macro-name"
              value={draft.name}
              maxLength={120}
              aria-invalid={nameIssues.length > 0 || undefined}
              aria-describedby={nameIssues.length > 0 ? 'macro-name-hint macro-name-error' : 'macro-name-hint'}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
            <p id="macro-name-hint" className="text-sm text-muted-foreground">
              {labels.nameHint}
            </p>
            <RowIssues id="macro-name-error" codes={nameIssues} labels={labels} fallback="name" />
          </div>
          <section aria-labelledby="macro-actions" className="flex flex-col gap-2">
            <h2 id="macro-actions" className="text-sm font-semibold uppercase text-secondary-foreground">
              {labels.actionsTitle}
            </h2>
            <p className="text-sm text-secondary-foreground">{labels.actionsHint}</p>
            <ActionRows rows={draft.actions} options={options} labels={labels} issues={issues} onChange={(actions) => setDraft((current) => ({ ...current, actions }))} />
          </section>
          <label className="inline-flex min-h-control items-center gap-3 text-sm">
            <input type="checkbox" checked={draft.isEnabled} className="size-5 shrink-0 accent-primary" onChange={(event) => setDraft((current) => ({ ...current, isEnabled: event.target.checked }))} />
            {labels.enabled}
          </label>
          <Button type="submit" disabled={saving} className="self-start">
            {labels.save}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
