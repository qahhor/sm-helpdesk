import { HUMAN_STAFF_ROLES } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { Label } from '@/ui/components/label';
import { inviteStaffAction } from './actions';
import { Select } from '@/ui/components/select';

export type InviteStaffLabels = { email: string; name: string; role: string; isLead: string; send: string; roles: Record<string, string> };

/** Приглашение сотрудника: адрес, имя, роль, руководитель линии. Обычная форма: работает и без скриптов. */
export function InviteStaffForm({ labels }: { labels: InviteStaffLabels }) {
  return (
    <form action={inviteStaffAction} className="flex flex-col gap-4">
      <FormField name="email" label={labels.email} type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} required />
      <FormField name="name" label={labels.name} autoComplete="off" maxLength={120} required />
      <div className="flex flex-col gap-1">
        <Label htmlFor="field-role">{labels.role}</Label>
        <Select id="field-role" name="role" defaultValue="agent_l1">
          {HUMAN_STAFF_ROLES.map((role) => (
            <option key={role} value={role}>
              {labels.roles[role]}
            </option>
          ))}
        </Select>
      </div>
      <label className="inline-flex min-h-control items-center gap-3">
        <input type="checkbox" name="isLead" className="size-5 shrink-0 accent-primary" />
        {labels.isLead}
      </label>
      <Button type="submit" className="self-start">
        {labels.send}
      </Button>
    </form>
  );
}
