'use client';

import { useActionState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { changeStaffPasswordAction, type PasswordChangeState } from './actions';

export type PasswordFormLabels = { current: string; next: string; nextHint: string; repeat: string; submit: string };

const START: PasswordChangeState = {};

/** Смена пароля сотрудником: текущий пароль и новый дважды (план подготовки M9, задача 1). */
export function PasswordForm({ email, labels }: { email: string; labels: PasswordFormLabels }) {
  const [state, action, pending] = useActionState(changeStaffPasswordAction, START);
  return (
    <form action={action} className="flex flex-col gap-4" aria-label={labels.submit}>
      {/* Скрытое поле помогает менеджеру паролей сохранить новый пароль под этим адресом. */}
      <input type="email" name="email" value={email} autoComplete="username" readOnly hidden />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <FormField name="currentPassword" type="password" label={labels.current} autoComplete="current-password" maxLength={128} required />
      <FormField name="newPassword" type="password" label={labels.next} hint={labels.nextHint} autoComplete="new-password" minLength={12} maxLength={128} required />
      <FormField name="newPasswordRepeat" type="password" label={labels.repeat} autoComplete="new-password" minLength={12} maxLength={128} required />
      <Button type="submit" disabled={pending} className="self-start">
        {labels.submit}
      </Button>
    </form>
  );
}
