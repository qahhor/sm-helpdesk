'use client';

import { useActionState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { staffSetupAction, type StaffSetupState } from './actions';

export type StaffSetupLabels = {
  name: string;
  password: string;
  passwordHint: string;
  passwordRepeat: string;
  submit: string;
};

const START: StaffSetupState = {};

/** Форма задания пароля по ссылке приглашения сотрудника. */
export function StaffSetupForm({
  token,
  email,
  name,
  labels,
}: {
  token: string;
  /** Адрес для входа. Скрытое поле помогает менеджеру паролей сохранить пароль под этим адресом. */
  email: string;
  name: string;
  labels: StaffSetupLabels;
}) {
  const [state, action, pending] = useActionState(staffSetupAction, START);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <input type="email" name="email" value={email} autoComplete="username" readOnly hidden />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <FormField name="name" label={labels.name} defaultValue={name} autoComplete="name" maxLength={120} required />
      <FormField
        name="password"
        type="password"
        label={labels.password}
        hint={labels.passwordHint}
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
      />
      <FormField
        name="passwordRepeat"
        type="password"
        label={labels.passwordRepeat}
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
      />
      <Button type="submit" disabled={pending}>
        {labels.submit}
      </Button>
    </form>
  );
}
