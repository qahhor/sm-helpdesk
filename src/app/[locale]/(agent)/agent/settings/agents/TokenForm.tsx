'use client';

import { useActionState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { Label } from '@/ui/components/label';
import { Textarea } from '@/ui/components/textarea';
import { issueTokenAction, type TokenFormState, type TokenFormValues, updateTokenAction } from './actions';
import { IssuedToken, type IssuedTokenLabels } from './IssuedToken';

// Форма токена AI-сотрудника (экран 8.12): имя (только при выпуске), инструменты группами "Чтение" и "Запись",
// разрешённые адреса, срок и суточный предел. После выпуска форма сменяется значением токена, которое портал
// показывает один раз. Тексты приходят свойствами.

export type ToolOption = { value: string; label: string };
export type TokenFormLabels = {
  name: string;
  nameHint: string;
  readTools: string;
  writeTools: string;
  toolsHint: string;
  allowedIps: string;
  allowedIpsHint: string;
  expiresAt: string;
  expiresAtHint: string;
  dailyLimit: string;
  dailyLimitHint: string;
  submit: string;
  reauth: string;
  issued: IssuedTokenLabels;
};

const START: TokenFormState = {};

function ToolGroup({ legend, hint, id, options, checked }: { legend: string; hint: string; id: string; options: ToolOption[]; checked: string[] }) {
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-hint`}>
      <legend className="text-sm font-medium">{legend}</legend>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {hint}
      </p>
      <div className="grid gap-x-6 gap-y-1 tablet:grid-cols-2">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-control items-start gap-3 py-1 text-sm">
            <input type="checkbox" name="tools" value={option.value} defaultChecked={checked.includes(option.value)} className="mt-0.5 size-5 shrink-0 accent-primary" />
            <span className="flex min-w-0 flex-col">
              <code className="wrap-anywhere font-mono text-sm">{option.value}</code>
              <span className="text-muted-foreground">{option.label}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function TokenForm({
  tokenId,
  defaults,
  readTools,
  writeTools,
  labels,
  reauthHref,
  tokenHref,
}: {
  /** Пусто: выпуск нового токена. */
  tokenId?: string;
  defaults: TokenFormValues;
  readTools: ToolOption[];
  writeTools: ToolOption[];
  labels: TokenFormLabels;
  /** Вход заново с возвратом на эту страницу: для ошибки "вход не свежий". */
  reauthHref: string;
  /** Адрес раздела без идентификатора: к нему добавляется идентификатор выпущенного токена. */
  tokenHref: string;
}) {
  const [state, action, pending] = useActionState(tokenId ? updateTokenAction : issueTokenAction, START);
  if (state.issued) return <IssuedToken value={state.issued.value} href={`${tokenHref}/${state.issued.tokenId}`} labels={labels.issued} />;
  const values = state.values ?? defaults;
  return (
    <form action={action} className="flex flex-col gap-5">
      {tokenId && <input type="hidden" name="tokenId" value={tokenId} />}
      {state.error && (
        <Alert tone="danger">
          {state.error}
          {state.reauth && (
            <>
              {' '}
              <a href={reauthHref} className="font-semibold underline">
                {labels.reauth}
              </a>
            </>
          )}
        </Alert>
      )}
      {!tokenId && <FormField name="name" label={labels.name} hint={labels.nameHint} defaultValue={values.name} maxLength={80} autoComplete="off" required />}
      <ToolGroup legend={labels.readTools} hint={labels.toolsHint} id={`tools-read-${tokenId ?? 'new'}`} options={readTools} checked={values.tools} />
      <ToolGroup legend={labels.writeTools} hint={labels.toolsHint} id={`tools-write-${tokenId ?? 'new'}`} options={writeTools} checked={values.tools} />
      <div className="flex flex-col gap-1">
        <Label htmlFor={`field-allowedIps-${tokenId ?? 'new'}`}>{labels.allowedIps}</Label>
        <Textarea
          id={`field-allowedIps-${tokenId ?? 'new'}`}
          name="allowedIps"
          defaultValue={values.allowedIps}
          aria-describedby={`field-allowedIps-${tokenId ?? 'new'}-hint`}
          className="min-h-20 font-mono"
          spellCheck={false}
          autoComplete="off"
          maxLength={4000}
          required
        />
        <p id={`field-allowedIps-${tokenId ?? 'new'}-hint`} className="text-sm text-muted-foreground">
          {labels.allowedIpsHint}
        </p>
      </div>
      <div className="grid gap-4 tablet:grid-cols-2">
        <FormField name="expiresAt" type="date" label={labels.expiresAt} hint={labels.expiresAtHint} defaultValue={values.expiresAt} required />
        <FormField name="dailyLimit" type="number" inputMode="numeric" min={1} max={10000} step={1} label={labels.dailyLimit} hint={labels.dailyLimitHint} defaultValue={values.dailyLimit} required />
      </div>
      <Button type="submit" disabled={pending} className="self-start">
        {labels.submit}
      </Button>
    </form>
  );
}
