import { Button } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { inviteMemberAction } from './actions';

export type InviteFormLabels = { email: string; role: string; user: string; admin: string; submit: string };

/** Приглашение коллеги: адрес и роль. Обычная форма: работает и без скриптов. */
export function InviteForm({ labels }: { labels: InviteFormLabels }) {
  return (
    <form action={inviteMemberAction} className="flex flex-col gap-4">
      <FormField name="email" label={labels.email} type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} required />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{labels.role}</legend>
        <label className="inline-flex min-h-control items-center gap-3">
          <input type="radio" name="role" value="client_user" defaultChecked className="size-5 accent-primary" />
          {labels.user}
        </label>
        <label className="inline-flex min-h-control items-center gap-3">
          <input type="radio" name="role" value="client_admin" className="size-5 accent-primary" />
          {labels.admin}
        </label>
      </fieldset>
      <Button type="submit" className="self-start">
        {labels.submit}
      </Button>
    </form>
  );
}
