'use client';

import { useActionState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { Label } from '@/ui/components/label';
import { cn } from '@/ui/cn';
import { saveServerAction, type ServerFormState, type ServerFormValues } from './actions';

export type ServerFormLabels = {
  code: string;
  codeHint: string;
  name: string;
  baseUrl: string;
  baseUrlHint: string;
  issuer: string;
  issuerHint: string;
  clientId: string;
  clientSecret: string;
  clientSecretHint: string;
  isDefault: string;
  roleMap: string;
  roleMapHint: string;
  endpoints: string;
  endpointsHint: string;
  authorization: string;
  token: string;
  userinfo: string;
  jwks: string;
  save: string;
  reauth: string;
};

const START: ServerFormState = {};

/**
 * Форма сервера Smartup: добавление (mode new) и изменение (mode edit, код не меняется).
 * Секрет вводится в поле вида "пароль" и на страницу не возвращается никогда: при изменении
 * пустое поле оставляет прежний секрет. После ошибки введённые значения остаются в полях, кроме секрета.
 */
export function ServerForm({
  mode,
  defaults,
  labels,
  reauthHref,
}: {
  mode: 'new' | 'edit';
  defaults: ServerFormValues;
  labels: ServerFormLabels;
  /** Вход заново с возвратом на эту страницу: для ошибки "вход не свежий". */
  reauthHref: string;
}) {
  const [state, action, pending] = useActionState(saveServerAction, START);
  const values = state.values ?? defaults;
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="mode" value={mode} />
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
      {mode === 'new' ? (
        <FormField
          name="code"
          label={labels.code}
          hint={labels.codeHint}
          defaultValue={values.code}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={31}
          required
        />
      ) : (
        <input type="hidden" name="code" value={values.code} />
      )}
      <FormField name="name" label={labels.name} defaultValue={values.name} maxLength={120} required />
      <FormField name="baseUrl" label={labels.baseUrl} hint={labels.baseUrlHint} defaultValue={values.baseUrl} type="url" maxLength={500} required />
      <FormField name="issuer" label={labels.issuer} hint={labels.issuerHint} defaultValue={values.issuer} type="url" maxLength={500} required />
      <FormField name="clientId" label={labels.clientId} defaultValue={values.clientId} autoComplete="off" spellCheck={false} maxLength={200} required />
      <FormField
        name="clientSecret"
        type="password"
        label={labels.clientSecret}
        hint={labels.clientSecretHint}
        autoComplete="new-password"
        maxLength={2000}
        required={mode === 'new'}
      />
      <label className="inline-flex min-h-control items-center gap-3">
        <input type="checkbox" name="isDefault" defaultChecked={values.isDefault === 'on'} className="size-5 shrink-0 accent-primary" />
        {labels.isDefault}
      </label>
      <div className="flex flex-col gap-1">
        <Label htmlFor="field-roleMap">{labels.roleMap}</Label>
        <textarea
          id="field-roleMap"
          name="roleMap"
          rows={3}
          defaultValue={values.roleMap}
          spellCheck={false}
          maxLength={4000}
          aria-describedby="field-roleMap-hint"
          className={cn(
            'w-full min-w-0 rounded-control border border-input bg-card px-3 py-2 text-base text-foreground outline-none',
            'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
          )}
        />
        <p id="field-roleMap-hint" className="text-sm text-muted-foreground">
          {labels.roleMapHint}
        </p>
      </div>
      <fieldset className="flex flex-col gap-3 border-t border-border pt-4" aria-describedby="endpoints-hint">
        <legend className="text-sm font-medium">{labels.endpoints}</legend>
        <p id="endpoints-hint" className="text-sm text-muted-foreground">
          {labels.endpointsHint}
        </p>
        <FormField name="authorization" label={labels.authorization} defaultValue={values.authorization} type="url" maxLength={500} />
        <FormField name="token" label={labels.token} defaultValue={values.token} type="url" maxLength={500} />
        <FormField name="userinfo" label={labels.userinfo} defaultValue={values.userinfo} type="url" maxLength={500} />
        <FormField name="jwks" label={labels.jwks} defaultValue={values.jwks} type="url" maxLength={500} />
      </fieldset>
      <Button type="submit" disabled={pending} className="self-start">
        {labels.save}
      </Button>
    </form>
  );
}
