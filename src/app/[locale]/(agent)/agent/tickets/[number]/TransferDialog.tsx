'use client';

import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/ui/components/dialog';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { transferAction } from './actions';

// Передача на вторую линию (FR-LINE-03, 8.12): окно поверх обращения, три обязательных поля, без них кнопка
// неактивна. Памятка первой линии для модуля и типа с флажками (FR-LINE-10), срок перед клиентом не меняется
// (FR-LINE-05). Сервис проверяет те же поля сам.

export type TransferLabels = {
  open: string;
  title: string;
  reason: string;
  reasonHint: string;
  playbook: string | null;
  noPlaybook: string;
  playbooksLink: string;
  checked: string;
  needed: string;
  deadline: string;
  cancel: string;
  submit: string;
  close: string;
};

type Props = { number: number; reasons: { value: string; label: string }[]; items: string[]; labels: TransferLabels };

export function TransferDialog({ number, reasons, items, labels }: Props) {
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState('');
  const [needed, setNeeded] = useState('');
  const complete = reason !== '' && checked.trim() !== '' && needed.trim() !== '';
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" className="w-full">
          {labels.open}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close}>
        <DialogTitle>{labels.title}</DialogTitle>
        <form action={transferAction} className="flex flex-col gap-4">
          <input type="hidden" name="number" value={number} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="transfer-reason">{labels.reason}</Label>
            <Select id="transfer-reason" name="reason" required value={reason} onChange={(event) => setReason(event.target.value)}>
              <option value="">{labels.reasonHint}</option>
              {reasons.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{labels.playbook ?? labels.noPlaybook}</legend>
            {items.map((item) => (
              <label key={item} className="inline-flex min-h-control items-center gap-3 text-sm">
                <input type="checkbox" name="checklist" value={item} className="size-5 accent-primary" />
                {item}
              </label>
            ))}
            <Link href="/agent/playbooks" className="text-sm text-link underline-offset-2 hover:underline">
              {labels.playbooksLink}
            </Link>
          </fieldset>
          <div className="flex flex-col gap-1">
            <Label htmlFor="transfer-checked">{labels.checked}</Label>
            <Textarea id="transfer-checked" name="checked" required maxLength={2000} value={checked} onChange={(event) => setChecked(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="transfer-needed">{labels.needed}</Label>
            <Textarea id="transfer-needed" name="needed" required maxLength={2000} value={needed} onChange={(event) => setNeeded(event.target.value)} />
          </div>
          <DialogDescription>{labels.deadline}</DialogDescription>
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {labels.cancel}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!complete}>
              {labels.submit}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
