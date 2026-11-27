import { AgentMark } from '@/ui/components/AgentMark';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Link } from '@/i18n/navigation';
import { acceptDraftAction, linkProposedAction, rejectDraftAction } from '../actions';

// Черновик известной проблемы от AI-сотрудника или всплеска сигнатуры (веха M8b, решение 20; FR-AGT-04, 07). Пока
// черновик не принят, он клиенту не виден и обращений не меняет: сигнатура неактивна, обращения только предложены.
// Описание агента показывается обычным текстом. Кнопки видит роль ведения проблем (agent_l2, care, admin).

export type AgentDraftLabels = {
  title: string;
  mark: string;
  hint: string;
  description: string;
  proposals: string;
  noProposals: string;
  accept: string;
  linkProposed: string;
  linkHint: string;
  reject: string;
  reason: string;
};

type Props = {
  number: number;
  isDraft: boolean;
  canWrite: boolean;
  description: string | null;
  proposals: { number: number; title: string; orgName: string }[];
  labels: AgentDraftLabels;
};

export function AgentDraftBlock({ number, isDraft, canWrite, description, proposals, labels }: Props) {
  if (!isDraft && proposals.length === 0) return null;
  const hidden = <input type="hidden" name="number" value={number} />;
  return (
    <Card data-agent-draft="">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{labels.title}</h2>
        {isDraft && <AgentMark label={labels.mark} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isDraft && <p className="text-sm text-secondary-foreground">{labels.hint}</p>}
        {description && (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-secondary-foreground">{labels.description}</p>
            <p className="whitespace-pre-wrap break-words text-sm" data-agent-text="">
              {description}
            </p>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-secondary-foreground">{labels.proposals}</p>
          {proposals.length === 0 ? (
            <p className="text-sm">{labels.noProposals}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {proposals.map((ticket) => (
                <li key={ticket.number}>
                  <Link href={`/agent/tickets/${ticket.number}`} className="text-link underline underline-offset-2">
                    #{ticket.number}
                  </Link>{' '}
                  {ticket.title}, {ticket.orgName}
                </li>
              ))}
            </ul>
          )}
        </div>
        {canWrite && (
          <div className="flex flex-col gap-3">
            {isDraft ? (
              <>
                <form action={acceptDraftAction}>
                  {hidden}
                  <Button type="submit">{labels.accept}</Button>
                </form>
                <form action={rejectDraftAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  {hidden}
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor="draft-reason">{labels.reason}</Label>
                    <Input id="draft-reason" name="reason" maxLength={500} />
                  </div>
                  <Button type="submit" variant="secondary">
                    {labels.reject}
                  </Button>
                </form>
              </>
            ) : (
              proposals.length > 0 && (
                <form action={linkProposedAction} className="flex flex-col gap-1">
                  {hidden}
                  <Button type="submit" variant="secondary" className="self-start">
                    {labels.linkProposed}
                  </Button>
                  <p className="text-xs text-secondary-foreground">{labels.linkHint}</p>
                </form>
              )
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
