import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { PROBLEM_WRITER_ROLES, problemRef } from '@/modules/hdp/api';
import { problemOfTicket } from '@/modules/hdp/api/problems';
import type { StaffContext } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { createFromTicketAction } from '../../problems/actions';
import { PROBLEM_STATUS_TONE } from '../../problems/status-tone';

// Блок "Известная проблема" в правой колонке обращения сотрудника (ТЗ 7.15, FR-KP-03, 04; план M5c, задачи 2 и 3).
// Видят все сотрудники. "Создать известную проблему" из обращения одним нажатием: agent_l2, care, admin.

const label = 'text-xs font-medium text-secondary-foreground';

export async function KnownProblemBlock({ staff, number, canLink }: { staff: StaffContext; number: number; canLink: boolean }) {
  const t = await getTranslations('agent.ticket.knownProblem');
  const s = await getTranslations('agent.problems');
  const problem = await problemOfTicket(staff, number);
  const canCreate = canLink && !problem && (PROBLEM_WRITER_ROLES as readonly string[]).includes(staff.actor.staffRole);
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
        {canCreate && (
          <form action={createFromTicketAction}>
            <input type="hidden" name="ticketNumber" value={number} />
            <Button type="submit" variant="secondary" size="small">
              {t('create')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
