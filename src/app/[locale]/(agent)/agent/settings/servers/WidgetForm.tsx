'use client';

import { useActionState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { CopyButton } from '@/ui/components/copy-button';
import { FormField } from '@/ui/components/form-field';
import { Label } from '@/ui/components/label';
import { Textarea } from '@/ui/components/textarea';
import { rotateContextSecretAction, saveWidgetAction, type WidgetFormState, type WidgetFormValues } from './actions';

export type WidgetFormLabels = {
  mode: string;
  modeHint: string;
  modes: { none: string; jwks: string; secret: string };
  contextIssuer: string;
  contextIssuerHint: string;
  jwksUrl: string;
  jwksUrlHint: string;
  embedOrigins: string;
  embedOriginsHint: string;
  save: string;
  saved: string;
  secret: string;
  secretSet: string;
  secretMissing: string;
  secretShownTitle: string;
  secretShownText: string;
  rotate: string;
  rotateHint: string;
  copy: string;
  copied: string;
  reauth: string;
};

const START: WidgetFormState = {};

/** Новый секрет: показывается один раз, с кнопкой копирования. */
function SecretShown({ secret, labels }: { secret: string; labels: WidgetFormLabels }) {
  return (
    <Alert tone="success">
      <p className="font-semibold">{labels.secretShownTitle}</p>
      <p>{labels.secretShownText}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="wrap-anywhere rounded-control bg-card-soft px-2 py-1" data-testid="context-secret">
          {secret}
        </code>
        <CopyButton text={secret} label={labels.copy} copiedLabel={labels.copied} />
      </div>
    </Alert>
  );
}

/**
 * Настройки виджета сервера (план M6, задача 1): режим подписи токена контекста, издатель, адрес ключей и адреса
 * встраивания. Общий секрет создаёт портал и показывает один раз, после сохранения или по кнопке "Создать новый секрет".
 */
export function WidgetForm({
  code,
  defaults,
  hasSecret,
  labels,
  reauthHref,
}: {
  code: string;
  defaults: WidgetFormValues;
  hasSecret: boolean;
  labels: WidgetFormLabels;
  reauthHref: string;
}) {
  const [state, action, pending] = useActionState(saveWidgetAction, START);
  const [rotated, rotate, rotating] = useActionState(rotateContextSecretAction, START);
  const values = state.values ?? defaults;
  const secret = rotated.secret ?? state.secret;
  const error = rotated.error ?? state.error;
  const reauth = rotated.reauth ?? state.reauth;
  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert tone="danger">
          {error}
          {reauth && (
            <>
              {' '}
              <a href={reauthHref} className="font-semibold underline">
                {labels.reauth}
              </a>
            </>
          )}
        </Alert>
      )}
      {state.saved && !error && <Alert tone="success">{labels.saved}</Alert>}
      {secret && <SecretShown secret={secret} labels={labels} />}
      <form action={action} className="flex flex-col gap-4" aria-label={labels.save}>
        <input type="hidden" name="code" value={code} />
        <fieldset className="flex flex-col gap-2" aria-describedby="widget-mode-hint">
          <legend className="text-sm font-medium">{labels.mode}</legend>
          {(['', 'jwks', 'secret'] as const).map((mode) => (
            <label key={mode || 'none'} className="inline-flex min-h-control items-center gap-3">
              <input type="radio" name="mode" value={mode} defaultChecked={values.mode === mode} className="size-5 shrink-0 accent-primary" />
              {labels.modes[mode || 'none']}
            </label>
          ))}
          <p id="widget-mode-hint" className="text-sm text-muted-foreground">
            {labels.modeHint}
          </p>
        </fieldset>
        <FormField
          name="contextIssuer"
          label={labels.contextIssuer}
          hint={labels.contextIssuerHint}
          defaultValue={values.contextIssuer}
          type="url"
          maxLength={500}
          spellCheck={false}
        />
        <FormField name="jwksUrl" label={labels.jwksUrl} hint={labels.jwksUrlHint} defaultValue={values.jwksUrl} type="url" maxLength={500} spellCheck={false} />
        <div className="flex flex-col gap-1">
          <Label htmlFor="field-embedOrigins">{labels.embedOrigins}</Label>
          <Textarea
            id="field-embedOrigins"
            name="embedOrigins"
            rows={3}
            className="min-h-0"
            defaultValue={values.embedOrigins}
            spellCheck={false}
            maxLength={2000}
            aria-describedby="field-embedOrigins-hint"
          />
          <p id="field-embedOrigins-hint" className="text-sm text-muted-foreground">
            {labels.embedOriginsHint}
          </p>
        </div>
        <Button type="submit" disabled={pending} className="self-start">
          {labels.save}
        </Button>
      </form>
      <div className="flex flex-col items-start gap-2 border-t border-border pt-4">
        <p className="text-sm">
          <span className="font-medium">{labels.secret}:</span> {hasSecret || secret ? labels.secretSet : labels.secretMissing}
        </p>
        {(hasSecret || secret) && (
          <form action={rotate} className="flex flex-col items-start gap-1">
            <input type="hidden" name="code" value={code} />
            <Button type="submit" variant="secondary" disabled={rotating}>
              {labels.rotate}
            </Button>
            <p className="text-sm text-muted-foreground">{labels.rotateHint}</p>
          </form>
        )}
      </div>
    </div>
  );
}
