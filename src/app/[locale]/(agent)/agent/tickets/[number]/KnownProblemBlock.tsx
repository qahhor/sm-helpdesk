import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { PROBLEM_WRITER_ROLES, problemRef } from '@/modules/hdp/api';
import { listProblems, problemOfTicket } from '@/modules/hdp/api/problems';
import type { StaffContext } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Input } from '@/ui/components/input';
import { createFromTicketAction, linkTicketAction, unlinkTicketAction } from '../../problems/actions';
import { PROBLEM_STATUS_TONE } from '../../problems/status-tone';

// Блок "Известная проблема" в правой колонке обращения сотрудника (ТЗ 7.15, FR-KP-03, 04; план M5c, задачи 2 и 3).
// Видят все сотрудники. Привязать (номер KP-n или часть названия активной проблемы) и отвязать может любой, кто ведёт
// обращения; "Создать известную проблему" из обращения одним нажатием: agent_l2, care, admin.

const label = 'text-xs font-medium text-secondary-foreground';

export async function KnownProblemBlock({ staff, number, canLink }: { staff: StaffContext; number: number; canLink: boolean }) {
  const t = await getTranslations('agent.ticket.knownProblem');
  const s = await getTranslations('agent.problems');
  const problem = await problemOfTicket(staff, number);
  const canCreate = canLink && !problem && (PROBLEM_WRITER_ROLES as readonly string[]).includes(staff.actor.staffRole);
  // Активные проблемы подсказкой поля привязки: их десятки (решение 27 плана M5c).
  const active = canLink && !problem ? await listProblems(staff, { status: 'active' }) : [];
  const hidden = <input type="hidden" name="ticketNumber" value={number} />;
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-6 text-sm" data-known-problem>
        <h2 className={label}>{t('title')}</h2>
        {problem ? (
          <>
            <p>
              <Link href={`/agent/problems/${problem.number}`} className="font-semibold text-link underline-offset-2 hover:underline">
                {problemRef(problem.number)}
              </Link>{' '}
              <span className="break-words">{problem.internalTitle}</span>
            </p>
            <p className="flex flex-wrap gap-1">
              <StatusLabel tone={PROBLEM_STATUS_TONE[problem.status]}>{s(`statuses.${problem.status}`)}</StatusLabel>
              {problem.showToClients && <StatusLabel tone="teal">{s('shown')}</StatusLabel>}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">{t('none')}</p>
        )}
        {problem && canLink && (
          <form action={unlinkTicketAction}>
            {hidden}
            <Button type="submit" variant="ghost" size="small">
              {t('unlink')}
            </Button>
          </form>
        )}
        {!problem && canLink && (
          <form action={linkTicketAction} className="flex flex-col gap-1">
            {hidden}
            <label htmlFor="ticket-problem" className={label}>
              {t('link')}
            </label>
            <Input id="ticket-problem" name="problem" required maxLength={200} list="ticket-problem-options" placeholder="KP-12" aria-describedby="ticket-problem-hint" />
            <datalist id="ticket-problem-options">
              {active.map((row) => (
                <option key={row.number} value={problemRef(row.number)}>
                  {row.internalTitle}
                </option>
              ))}
            </datalist>
            <p id="ticket-problem-hint" className="text-xs text-muted-foreground">
              {t('linkHint')}
            </p>
            <Button type="submit" variant="secondary" size="small" className="self-start">
              {t('linkSubmit')}
            </Button>
          </form>
        )}
        {canCreate && (
          <form action={createFromTicketAction}>
            {hidden}
            <Button type="submit" variant="secondary" size="small">
              {t('create')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
