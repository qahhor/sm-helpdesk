'use client';

import { useActionState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { saveWebhookAction, type WebhookFormState, type WebhookFormValues } from './actions';
import { type SecretLabels, SecretOnce } from './SecretOnce';

// Форма адреса вебхука (FR-ADM-11): название, адрес приёмника, подписки на события, включение. После создания
// форма сменяется секретом подписи, который портал показывает один раз. Тексты приходят свойствами.

export type WebhookFormLabels = {
  name: string;
  nameHint: string;
  url: string;
  urlHint: string;
  events: string;
  eventsHint: string;
  enabled: string;
  submit: string;
  reauth: string;
  openEndpoint: string;
  secret: SecretLabels;
};

const START: WebhookFormState = {};

export function WebhookForm({
  endpointId,
  defaults,
  events,
  labels,
  reauthHref,
  endpointHref,
}: {
  /** Пусто: новый адрес. */
  endpointId?: string;
  defaults: WebhookFormValues;
  events: { value: string; label: string }[];
  labels: WebhookFormLabels;
  /** Вход заново с возвратом на эту страницу: для ошибки "вход не свежий". */
  reauthHref: string;
  /** Адрес страницы адреса вебхука без идентификатора: к нему добавляется идентификатор созданного. */
  endpointHref: string;
}) {
  const [state, action, pending] = useActionState(saveWebhookAction, START);
  if (state.created)
    return (
      <div className="flex flex-col gap-4">
        <SecretOnce secret={state.created.secret} labels={labels.secret} />
        <a href={`${endpointHref}/${state.created.endpointId}`} className={buttonVariants({ variant: 'secondary', className: 'self-start' })}>
          {labels.openEndpoint}
        </a>
      </div>
    );
  const values = state.values ?? defaults;
  return (
    <form action={action} className="flex flex-col gap-4">
      {endpointId && <input type="hidden" name="endpointId" value={endpointId} />}
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
      <FormField name="name" label={labels.name} hint={labels.nameHint} defaultValue={values.name} maxLength={120} required />
      <FormField name="url" label={labels.url} hint={labels.urlHint} defaultValue={values.url} type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2000} required />
      <fieldset className="flex flex-col gap-2" aria-describedby="webhook-events-hint">
        <legend className="text-sm font-medium">{labels.events}</legend>
        <p id="webhook-events-hint" className="text-sm text-muted-foreground">
          {labels.eventsHint}
        </p>
        <div className="grid gap-x-6 tablet:grid-cols-2">
          {events.map((event) => (
            <label key={event.value} className="inline-flex min-h-control items-center gap-3 text-sm">
              <input type="checkbox" name="events" value={event.value} defaultChecked={values.events.includes(event.value)} className="size-5 shrink-0 accent-primary" />
              {event.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="inline-flex min-h-control items-center gap-3 text-sm">
        <input type="checkbox" name="isEnabled" defaultChecked={values.isEnabled} className="size-5 shrink-0 accent-primary" />
        {labels.enabled}
      </label>
      <Button type="submit" disabled={pending} className="self-start">
        {labels.submit}
      </Button>
    </form>
  );
}
