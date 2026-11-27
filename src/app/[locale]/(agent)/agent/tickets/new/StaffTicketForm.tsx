'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/ui/components/button';
import { FilePicker, type FilePickerLabels } from '@/ui/components/file-picker';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { createForClientAction } from './actions';

// Форма обращения за клиента (FR-AG-08): участник выбранной организации, поля как у клиента, приоритет можно
// подтвердить сразу. Файлы загружаются в карантин организации обращения тем же путём, что у клиента.

type Option = { value: string; label: string };

export type StaffTicketLabels = {
  author: string;
  intake: string;
  intakeChoose: string;
  intakeHint: string;
  type: string;
  impact: string;
  priority: string;
  priorityByImpact: string;
  title: string;
  titleHint: string;
  description: string;
  module: string;
  moduleNone: string;
  visibility: string;
  locale: string;
  submit: string;
  busy: string;
  files: FilePickerLabels;
};

type Props = {
  orgId: string;
  members: Option[];
  intakeChannels: Option[];
  types: Option[];
  impacts: Option[];
  priorities: Option[];
  modules: Option[];
  visibilities: Option[];
  locales: Option[];
  defaultLocale: string;
  accept: string;
  maxFiles: number;
  labels: StaffTicketLabels;
};

export function StaffTicketForm(props: Props) {
  const { orgId, labels } = props;
  const [uploading, setUploading] = useState(false);
  const extra = useMemo(() => ({ orgId }), [orgId]);
  const select = (id: string, name: string, label: string, options: Option[], defaultValue: string, required = true) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} name={name} required={required} defaultValue={defaultValue}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
  return (
    <form action={createForClientAction} className="flex flex-col gap-4">
      <input type="hidden" name="orgId" value={orgId} />
      {select('new-author', 'authorId', labels.author, props.members, props.members[0]?.value ?? '')}
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-intake">{labels.intake}</Label>
        <Select id="new-intake" name="intakeChannel" required defaultValue="" aria-describedby="new-intake-hint">
          <option value="" disabled>
            {labels.intakeChoose}
          </option>
          {props.intakeChannels.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <p id="new-intake-hint" className="text-sm text-muted-foreground">
          {labels.intakeHint}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {select('new-type', 'type', labels.type, props.types, 'bug')}
        {select('new-impact', 'impact', labels.impact, props.impacts, 'minor')}
        {select('new-priority', 'priority', labels.priority, [{ value: '', label: labels.priorityByImpact }, ...props.priorities], '', false)}
        {select('new-module', 'moduleId', labels.module, [{ value: '', label: labels.moduleNone }, ...props.modules], '', false)}
        {select('new-visibility', 'visibility', labels.visibility, props.visibilities, 'org')}
        {select('new-locale', 'locale', labels.locale, props.locales, props.defaultLocale)}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-title">{labels.title}</Label>
        <Input id="new-title" name="title" maxLength={200} aria-describedby="new-title-hint" />
        <p id="new-title-hint" className="text-xs text-muted-foreground">
          {labels.titleHint}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-description">{labels.description}</Label>
        <Textarea id="new-description" name="description" required maxLength={20000} className="min-h-32" />
      </div>
      <FilePicker accept={props.accept} maxFiles={props.maxFiles} labels={labels.files} onBusyChange={setUploading} presignExtra={extra} />
      {uploading && <p className="text-sm text-muted-foreground">{labels.busy}</p>}
      <Button type="submit" disabled={uploading} className="self-end">
        {labels.submit}
      </Button>
    </form>
  );
}
