import { getTranslations } from 'next-intl/server';
import { type AgentTicketView, allowedStaffTransitions, PRIORITIES, RESOLUTION_TYPES, TICKET_TYPES } from '@/modules/hdt/api';
import type { AssignableStaff } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Select } from '@/ui/components/select';
import { assignAction, moduleAction, priorityAction, snoozeAction, statusAction, takeAction, typeAction } from './actions';

// Управление обращением в боковой панели (FR-AG-02, FR-AG-04, FR-AG-09, FR-AG-13, FR-SLA-03, UX-A-11).
// Обычные формы: работают без JavaScript, итог показывает страница. Роль product видит панель без форм.

type Props = {
  ticket: AgentTicketView;
  me: string;
  role: string;
  staff: AssignableStaff[];
  modules: { moduleId: string; name: string }[];
};

const field = 'flex flex-col gap-1';
const label = 'text-xs font-medium text-secondary-foreground';

export async function TicketControls({ ticket, me, role, staff, modules }: Props) {
  const t = await getTranslations('agent.ticket.controls');
  const tq = await getTranslations('agent.queues');
  const tt = await getTranslations('agent.ticket');
  if (role === 'product') return null;
  const hidden = <input type="hidden" name="number" value={ticket.number} />;
  const transitions = allowedStaffTransitions(ticket.status, role);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6 text-sm">
        <h2 className="text-xs font-medium text-secondary-foreground">{t('title')}</h2>
        {ticket.assignee?.id !== me && (
          <form action={takeAction}>
            {hidden}
            <Button type="submit" className="w-full">
              {t('take')}
            </Button>
          </form>
        )}

        <form action={assignAction} className={field}>
          {hidden}
          <label htmlFor="ctl-assignee" className={label}>
            {t('assignee')}
          </label>
          <div className="flex gap-2">
            <Select id="ctl-assignee" name="assigneeId" defaultValue={ticket.assignee?.id ?? ''}>
              <option value="">{tq('unassigned')}</option>
              {staff.map((s) => (
                <option key={s.userId} value={s.userId}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="secondary">
              {t('apply')}
            </Button>
          </div>
        </form>

        {transitions.length > 0 && (
          <form action={statusAction} className={field}>
            {hidden}
            <label htmlFor="ctl-status" className={label}>
              {t('status')}
            </label>
            <Select id="ctl-status" name="to" defaultValue={transitions[0]}>
              {transitions.map((status) => (
                <option key={status} value={status}>
                  {tq(`statuses.${status}`)}
                </option>
              ))}
            </Select>
            {transitions.includes('resolved') && (
              <>
                <label htmlFor="ctl-resolution" className={label}>
                  {t('resolution')}
                </label>
                <Select id="ctl-resolution" name="resolution" defaultValue="">
                  <option value="">{t('resolutionHint')}</option>
                  {RESOLUTION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`resolutions.${type}`)}
                    </option>
                  ))}
                </Select>
                <label htmlFor="ctl-version" className={label}>
                  {t('version')}
                </label>
                <Input id="ctl-version" name="version" maxLength={50} placeholder="5.12.3" />
              </>
            )}
            <Button type="submit" variant="secondary">
              {t('changeStatus')}
            </Button>
          </form>
        )}

        <form action={priorityAction} className={field}>
          {hidden}
          <label htmlFor="ctl-priority" className={label}>
            {t('priority')}
          </label>
          <Select id="ctl-priority" name="priority" defaultValue={ticket.priority}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </Select>
          <label htmlFor="ctl-reason" className={label}>
            {t('reason')}
          </label>
          <Input id="ctl-reason" name="reason" required maxLength={500} />
          <Button type="submit" variant="secondary">
            {ticket.priorityConfirmed ? t('changePriority') : t('confirmPriority')}
          </Button>
        </form>

        <form action={typeAction} className={field}>
          {hidden}
          <label htmlFor="ctl-type" className={label}>
            {t('type')}
          </label>
          <div className="flex gap-2">
            <Select id="ctl-type" name="type" defaultValue={ticket.type}>
              {TICKET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {tt(`types.${type}`)}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="secondary">
              {t('apply')}
            </Button>
          </div>
        </form>

        {modules.length > 0 && (
          <form action={moduleAction} className={field}>
            {hidden}
            <label htmlFor="ctl-module" className={label}>
              {t('module')}
            </label>
            <div className="flex gap-2">
              <Select id="ctl-module" name="moduleId" defaultValue={ticket.moduleId ?? ''}>
                <option value="">{t('noModule')}</option>
                {modules.map((m) => (
                  <option key={m.moduleId} value={m.moduleId}>
                    {m.name}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="secondary">
                {t('apply')}
              </Button>
            </div>
          </form>
        )}

        <form action={snoozeAction} className={field}>
          {hidden}
          <span className={label}>{t('snooze')}</span>
          <div className="flex flex-wrap gap-2">
            {(['hour', 'tomorrow', 'monday'] as const).map((preset, index) => (
              <Button key={preset} type="submit" name="preset" value={preset} variant="secondary" size="small" data-snooze-first={index === 0 ? '' : undefined}>
                {t(`snoozePresets.${preset}`)}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input type="datetime-local" name="until" aria-label={t('snoozeUntil')} />
            <Button type="submit" name="preset" value="custom" variant="secondary">
              {t('snoozeApply')}
            </Button>
          </div>
          {ticket.snoozedUntil && (
            <Button type="submit" name="preset" value="clear" variant="ghost" size="small" className="self-start">
              {t('unsnooze')}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
