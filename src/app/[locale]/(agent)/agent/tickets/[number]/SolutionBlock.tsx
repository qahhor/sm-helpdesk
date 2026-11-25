import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { solutionOfTicket } from '@/modules/hdk/api/from-ticket';
import { canWriteSolutions } from '@/modules/hdk/api/editor';
import type { StaffContext } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { createSolutionAction } from './actions';

// Решение из обращения на странице сотрудника (план M5, задача 7; UX-W-09, FR-SOL-02): ссылка на выросшее решение
// или кнопка "Создать решение" у решённого и закрытого обращения. Клиент этого блока не видит: страница сотрудника.

export async function SolutionBlock({ staff, ticketId, number, status }: { staff: StaffContext; ticketId: string; number: number; status: string }) {
  const t = await getTranslations('agent.ticket.solution');
  const solution = await solutionOfTicket(staff, ticketId);
  const canCreate = canWriteSolutions(staff) && (status === 'resolved' || status === 'closed');
  if (solution === null && !canCreate) return null;
  return (
    <Card data-testid="ticket-solution">
      <CardContent className="flex flex-col gap-2 pt-6 text-sm">
        <h2 className="text-xs font-medium text-secondary-foreground">{t('title')}</h2>
        {solution !== null ? (
          <Link href={`/agent/solutions/${solution}`} className="font-semibold text-link underline">
            {t('open', { number: solution })}
          </Link>
        ) : (
          <form action={createSolutionAction} className="flex flex-col gap-2">
            <input type="hidden" name="number" value={number} />
            <p className="text-secondary-foreground">{t('hint')}</p>
            <Button type="submit" variant="secondary" className="self-start">
              {t('create')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
