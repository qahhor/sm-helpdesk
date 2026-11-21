import { Button } from '@/ui/components/button';
import { Label } from '@/ui/components/label';
import { RadioGroup } from '@/ui/components/radio-group';
import { Textarea } from '@/ui/components/textarea';
import { Link } from '@/i18n/navigation';
import { confirmAction, rateAction, reopenAction, visibilityAction, watchAction } from './actions';

// Действия клиента по обращению (FR-TK-09 - FR-TK-12): видны только разрешённые (TicketView.can).
// Обычные формы: работают и без скриптов.

export type TicketActionLabels = {
  confirm: string;
  reopen: string;
  reopenHint: string;
  reopenClosed: string;
  createNew: string;
  toOrg: string;
  toPrivate: string;
  watch: string;
  unwatch: string;
  rateTitle: string;
  rateScore: string;
  rateReason: string;
  rateReasonHint: string;
  rateComment: string;
  rateSubmit: string;
  scores: { value: string; label: string }[];
  reasons: { value: string; label: string }[];
};

export function TicketActions({
  number,
  status,
  visibility,
  watching,
  can,
  labels,
}: {
  number: number;
  status: string;
  visibility: string;
  watching: boolean;
  can: { confirm: boolean; reopen: boolean; rate: boolean; changeVisibility: boolean; watch: boolean };
  labels: TicketActionLabels;
}) {
  const hidden = <input type="hidden" name="number" value={number} />;
  const closed = status === 'closed';
  return (
    <div className="flex flex-col gap-4">
      {(can.confirm || can.reopen || can.changeVisibility || can.watch) && (
        <div className="flex flex-wrap gap-2">
          {can.confirm && (
            <form action={confirmAction}>
              {hidden}
              <Button type="submit" variant="secondary">
                {labels.confirm}
              </Button>
            </form>
          )}
          {can.reopen && (
            <form action={reopenAction}>
              {hidden}
              <Button type="submit" variant="secondary">
                {closed ? labels.reopenClosed : labels.reopen}
              </Button>
            </form>
          )}
          {can.changeVisibility && (
            <form action={visibilityAction}>
              {hidden}
              <input type="hidden" name="visibility" value={visibility === 'org' ? 'private' : 'org'} />
              <Button type="submit" variant="secondary">
                {visibility === 'org' ? labels.toPrivate : labels.toOrg}
              </Button>
            </form>
          )}
          {can.watch && (
            <form action={watchAction}>
              {hidden}
              <input type="hidden" name="watch" value={watching ? '0' : '1'} />
              <Button type="submit" variant="ghost">
                {watching ? labels.unwatch : labels.watch}
              </Button>
            </form>
          )}
        </div>
      )}
      {can.reopen && <p className="text-sm text-muted-foreground">{labels.reopenHint}</p>}
      {closed && !can.reopen && (
        <Link href={`/tickets/new?related=${number}`} className="self-start text-link underline underline-offset-2">
          {labels.createNew}
        </Link>
      )}
      {can.rate && (
        <form action={rateAction} className="flex flex-col gap-3">
          {hidden}
          <h2 className="text-lg font-semibold">{labels.rateTitle}</h2>
          <RadioGroup name="score" legend={labels.rateScore} options={labels.scores} defaultValue="5" />
          <RadioGroup name="reason" legend={labels.rateReason} options={labels.reasons} hint={labels.rateReasonHint} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="field-comment">{labels.rateComment}</Label>
            <Textarea id="field-comment" name="comment" maxLength={2000} className="min-h-20" />
          </div>
          <Button type="submit" variant="secondary" className="self-start">
            {labels.rateSubmit}
          </Button>
        </form>
      )}
    </div>
  );
}
