import { getTranslations } from 'next-intl/server';
import { DEV_TASK_REF_MAX, DEV_TASK_STATUSES, DEV_TASK_TITLE_MAX, DEV_TASK_URL_MAX, DEV_TASK_VERSION_MAX, type DevTaskStatus, type DevTaskView } from '@/modules/hdw/api';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Select } from '@/ui/components/select';
import { StatusLabel, type StatusTone } from '@/ui/components/StatusLabel';
import { devTaskStatusAction, unlinkDevAction } from './actions';
import { DevTaskDialog } from './DevTaskDialog';

// Блок "Задача разработки" в боковой панели обращения (раздел 8.4 "РАЗРАБОТКА", FR-DEV-02, 05, 06; план M8,
// задача 7). Номер задачи это обычная внешняя ссылка: портал по ней не ходит. Блок видят все сотрудники, формы
// только роли, которым разрешён статус "В разработке". Клиентские страницы блока не показывают.

const TONE: Record<DevTaskStatus, StatusTone> = { todo: 'gray', in_progress: 'blue', done: 'green', cancelled: 'orange' };
const label = 'text-xs font-medium text-secondary-foreground';

type Props = {
  number: number;
  devTask: DevTaskView | null;
  /** Сотрудник может отвязать задачу и сменить её статус. */
  canManage: boolean;
  /** Сотрудник может передать обращение в разработку прямо сейчас. */
  canHandOver: boolean;
};

export async function DevTaskBlock({ number, devTask, canManage, canHandOver }: Props) {
  const t = await getTranslations('agent.ticket.devTask');
  const hidden = <input type="hidden" name="number" value={number} />;
  const task = devTask?.task ?? null;
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-6 text-sm" data-dev-task>
        <h2 className={label}>{t('title')}</h2>
        {!task && <p className="text-muted-foreground">{t('none')}</p>}
        {task && (
          <>
            <p>
              <a href={task.url} target="_blank" rel="noopener noreferrer" className="break-all font-semibold text-link underline-offset-2 hover:underline">
                {t('link', { ref: task.externalId })}
                <span className="sr-only"> ({t('external')})</span>
              </a>
            </p>
            {task.title && <p className="break-words">{task.title}</p>}
            <p className="flex flex-wrap items-center gap-2">
              <span className="sr-only">{t('status')}:</span>
              <StatusLabel tone={TONE[task.status]}>{t(`statuses.${task.status}`)}</StatusLabel>
              {task.version && <span>{t('version', { version: task.version })}</span>}
            </p>
            {devTask && devTask.otherTickets.length > 0 && (
              <p className="flex flex-wrap gap-x-2">
                <span>{t('also')}:</span>
                {devTask.otherTickets.map((other) => (
                  <Link key={other} href={`/agent/tickets/SUP-${other}`} className="text-link underline-offset-2 hover:underline">
                    SUP-{other}
                  </Link>
                ))}
              </p>
            )}
            {canManage && task.tracker === 'manual' && (
              <form action={devTaskStatusAction} className="flex flex-col gap-1">
                {hidden}
                <input type="hidden" name="devTaskId" value={task.devTaskId} />
                <label htmlFor="dev-task-status" className={label}>
                  {t('status')}
                </label>
                <Select id="dev-task-status" name="status" defaultValue={task.status}>
                  {DEV_TASK_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {t(`statuses.${status}`)}
                    </option>
                  ))}
                </Select>
                <label htmlFor="dev-task-version" className={label}>
                  {t('versionField')}
                </label>
                <Input id="dev-task-version" name="version" maxLength={DEV_TASK_VERSION_MAX} defaultValue={task.version ?? ''} placeholder="5.12.3" aria-describedby="dev-task-version-hint" />
                <p id="dev-task-version-hint" className="text-xs text-muted-foreground">
                  {t('versionHint')}
                </p>
                <Button type="submit" variant="secondary">
                  {t('changeStatus')}
                </Button>
              </form>
            )}
            {canManage && (
              <form action={unlinkDevAction}>
                {hidden}
                <Button type="submit" variant="ghost" size="small">
                  {t('unlink')}
                </Button>
              </form>
            )}
          </>
        )}
        {canHandOver && (
          <DevTaskDialog
            number={number}
            limits={{ ref: DEV_TASK_REF_MAX, url: DEV_TASK_URL_MAX, title: DEV_TASK_TITLE_MAX }}
            labels={{
              open: t('open'),
              title: t('dialogTitle'),
              text: t('dialogText'),
              ref: t('ref'),
              refHint: t('refHint'),
              url: t('url'),
              urlHint: t('urlHint'),
              taskTitle: t('taskTitle'),
              cancel: t('cancel'),
              submit: t('submit'),
              close: t('close'),
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
