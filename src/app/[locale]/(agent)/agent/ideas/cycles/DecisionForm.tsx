'use client';

import { useState, useTransition } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Label } from '@/ui/components/label';
import { Textarea } from '@/ui/components/textarea';
import { decideCycleAction, draftExplanationAction } from '../actions';

// Выбор идеи месяца (ТЗ FR-IDEA-10; план M7, задача 9, решение 17). Лидер снимка выбран по умолчанию; для не лидера
// объяснение на русском обязательно (это же проверяют сервер и база). "Перевести" кладёт в поля узбекского и
// английского машинный черновик с пометкой: сотрудник читает и правит его, на сервер уходит только то, что он сохранил.

export type DecisionOption = { number: number; label: string; leader: boolean };
export type DecisionLabels = {
  legend: string;
  leader: string;
  ru: string;
  uz: string;
  en: string;
  explanationHint: string;
  translate: string;
  translating: string;
  machine: string;
  draftError: string;
  submit: string;
};

export function DecisionForm({ cycle, options, max, labels }: { cycle: string; options: DecisionOption[]; max: number; labels: DecisionLabels }) {
  const leader = options.find((o) => o.leader)?.number ?? options[0]?.number ?? 0;
  const [picked, setPicked] = useState(leader);
  const [ru, setRu] = useState('');
  const [uz, setUz] = useState('');
  const [en, setEn] = useState('');
  const [machine, setMachine] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const needsExplanation = picked !== leader;

  const translate = () =>
    startTransition(async () => {
      const draft = await draftExplanationAction(ru);
      if ('error' in draft) {
        setDraftFailed(true);
        return;
      }
      setDraftFailed(false);
      setUz(draft.uz);
      setEn(draft.en);
      setMachine(true);
    });

  return (
    <form action={decideCycleAction} className="flex flex-col gap-4" data-testid="cycle-decision">
      <input type="hidden" name="cycle" value={cycle} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-semibold">{labels.legend}</legend>
        {options.map((option) => (
          <label key={option.number} className="flex items-start gap-2">
            <input type="radio" name="number" value={option.number} checked={picked === option.number} onChange={() => setPicked(option.number)} className="mt-1 size-4 accent-primary" />
            <span className="break-words">
              {option.label}
              {option.leader && <span className="text-secondary-foreground"> ({labels.leader})</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-secondary-foreground">{labels.explanationHint}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="explanation-ru">{labels.ru}</Label>
        <Textarea id="explanation-ru" name="explanationRu" rows={4} maxLength={max} required={needsExplanation} value={ru} onChange={(e) => setRu(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="small" disabled={pending || ru.trim() === ''} onClick={translate}>
          {pending ? labels.translating : labels.translate}
        </Button>
      </div>
      {draftFailed && <Alert tone="danger">{labels.draftError}</Alert>}
      {machine && <Alert tone="info">{labels.machine}</Alert>}
      <div className="flex flex-col gap-1">
        <Label htmlFor="explanation-uz">{labels.uz}</Label>
        <Textarea id="explanation-uz" name="explanationUz" rows={4} maxLength={max} value={uz} onChange={(e) => setUz(e.target.value)} lang="uz" />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="explanation-en">{labels.en}</Label>
        <Textarea id="explanation-en" name="explanationEn" rows={4} maxLength={max} value={en} onChange={(e) => setEn(e.target.value)} lang="en" />
      </div>
      <Button type="submit" className="self-start">
        {labels.submit}
      </Button>
    </form>
  );
}
