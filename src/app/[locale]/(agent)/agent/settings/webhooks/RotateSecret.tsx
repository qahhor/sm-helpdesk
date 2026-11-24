'use client';

import { useActionState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/ui/components/dialog';
import { rotateSecretAction, type SecretState } from './actions';
import { type SecretLabels, SecretOnce } from './SecretOnce';

// Смена секрета подписи с подтверждением (план M8, решение 9): прежний секрет перестаёт действовать сразу, новый
// показывается один раз вместо кнопки.

export type RotateLabels = { open: string; title: string; text: string; confirm: string; cancel: string; close: string; reauth: string; set: string; secret: SecretLabels };

const START: SecretState = {};

export function RotateSecret({ endpointId, labels, reauthHref }: { endpointId: string; labels: RotateLabels; reauthHref: string }) {
  const [state, action, pending] = useActionState(rotateSecretAction, START);
  if (state.secret) return <SecretOnce secret={state.secret} labels={labels.secret} />;
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-secondary-foreground">{labels.set}</p>
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
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="secondary">{labels.open}</Button>
        </DialogTrigger>
        <DialogContent closeLabel={labels.close}>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.text}</DialogDescription>
          <form action={action} className="flex flex-wrap justify-end gap-2">
            <input type="hidden" name="endpointId" value={endpointId} />
            <DialogClose asChild>
              <Button variant="secondary">{labels.cancel}</Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {labels.confirm}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
