'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { bulkQueueAction, type BulkState } from './actions';

// Массовые действия в очереди (FR-AG-20, UX-A-10): назначить, передать на вторую линию с запиской, вернуть на
// первую с пояснением, закрыть как дубль. Флажки строк принадлежат этой форме (атрибут form). Итог по каждому.

export const BULK_FORM_ID = 'bulk-form';

type Option = { value: string; label: string };

export type BulkLabels = {
  title: string;
  action: string;
  actions: Record<'assign' | 'queue_l2' | 'queue_l1' | 'duplicate', string>;
  assignee: string;
  unassigned: string;
  reason: string;
  reasonHint: string;
  checked: string;
  needed: string;
  explanation: string;
  into: string;
  submit: string;
  done: string;
  refused: string;
  errors: Record<string, string>;
};

const INITIAL: BulkState = { status: 'idle' };

export function BulkBar({ staff, reasons, labels }: { staff: Option[]; reasons: Option[]; labels: BulkLabels }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(bulkQueueAction, INITIAL);
  const [kind, setKind] = useState<keyof BulkLabels['actions']>('assign');
  useEffect(() => {
    if (state.status === 'done' && state.done.length > 0) router.refresh();
  }, [state, router]);
  const errorText = (code: string) => labels.errors[code] ?? labels.errors.other ?? code;

  return (
    <form id={BULK_FORM_ID} action={action} className="flex flex-col gap-3 rounded-control border border-border bg-card p-3" aria-label={labels.title}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="bulk-action">{labels.action}</Label>
          <Select id="bulk-action" name="action" value={kind} onChange={(event) => setKind(event.target.value as keyof BulkLabels['actions'])}>
            {(Object.keys(labels.actions) as (keyof BulkLabels['actions'])[]).map((key) => (
              <option key={key} value={key}>
                {labels.actions[key]}
              </option>
            ))}
          </Select>
        </div>
        {kind === 'assign' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-assignee">{labels.assignee}</Label>
            <Select id="bulk-assignee" name="assigneeId" defaultValue="">
              <option value="">{labels.unassigned}</option>
              {staff.map((person) => (
                <option key={person.value} value={person.value}>
                  {person.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        {kind === 'queue_l2' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-reason">{labels.reason}</Label>
            <Select id="bulk-reason" name="reason" required defaultValue="">
              <option value="">{labels.reasonHint}</option>
              {reasons.map((reason) => (
                <option key={reason.value} value={reason.value}>
                  {reason.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        {kind === 'duplicate' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-into">{labels.into}</Label>
            <Input id="bulk-into" name="into" required maxLength={20} placeholder="SUP-1042" />
          </div>
        )}
        <Button type="submit" disabled={pending}>
          {labels.submit}
        </Button>
      </div>
      {kind === 'queue_l2' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-checked">{labels.checked}</Label>
            <Textarea id="bulk-checked" name="checked" required maxLength={2000} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-needed">{labels.needed}</Label>
            <Textarea id="bulk-needed" name="needed" required maxLength={2000} />
          </div>
        </div>
      )}
      {kind === 'queue_l1' && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="bulk-explanation">{labels.explanation}</Label>
          <Textarea id="bulk-explanation" name="explanation" required maxLength={2000} />
        </div>
      )}
      {state.status === 'error' && <Alert tone="danger">{errorText(state.code)}</Alert>}
      {state.status === 'done' && (
        <Alert tone={state.refused.length > 0 ? 'info' : 'success'}>
          <p>{labels.done.replace('{count}', String(state.done.length))}</p>
          {state.refused.length > 0 && (
            <ul className="list-disc ps-5">
              {state.refused.map((item) => (
                <li key={item.number}>{labels.refused.replace('{number}', `SUP-${item.number}`).replace('{reason}', errorText(item.code))}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
    </form>
  );
}
