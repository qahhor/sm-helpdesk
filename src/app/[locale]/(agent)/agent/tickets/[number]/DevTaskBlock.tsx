import { getTranslations } from 'next-intl/server';
import { DEV_TASK_REF_MAX, DEV_TASK_STATUSES, DEV_TASK_TITLE_MAX, DEV_TASK_URL_MAX, DEV_TASK_VERSION_MAX, type DevTaskStatus, type DevTaskView, type DevTrackerKind } from '@/modules/hdw/api';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Select } from '@/ui/components/select';
import { StatusLabel, type StatusTone } from '@/ui/components/StatusLabel';
import { devTaskStatusAction, sendToDevAction, unlinkDevAction } from './actions';
import { DevTaskDialog } from './DevTaskDialog';

// Блок "Задача разработки" в боковой панели обращения (раздел 8.4 "РАЗРАБОТКА", FR-DEV-02, 05, 06; план M8,
// задача 7). Номер задачи это обычная внешняя ссылка: портал по ней не ходит. Блок видят все сотрудники, формы
// только роли, которым разрешён статус "В разработке". Клиентские страницы блока не показывают. Тот же блок стоит на
// карточке известной проблемы (план M5c, задача 8): свои действия и подписи передаёт карточка.

const TONE: Record<DevTaskStatus, StatusTone> = { todo: 'gray', in_progress: 'blue', done: 'green', cancelled: 'orange' };
const label = 'text-xs font-medium text-secondary-foreground';

type Props = {
  number: number;
  devTask: DevTaskView | null;
  /** Сотрудник может отвязать задачу и сменить её статус. */
  canManage: boolean;
  /** Сотрудник может передать обращение в разработку прямо сейчас. */
  canHandOver: boolean;
  /** Режим таск-менеджера: в ручном окно передачи спрашивает номер, ссылку и название задачи. */
  mode: DevTrackerKind;
  /** Карточка известной проблемы: свои действия и подписи (agent.problems.devTask поверх agent.ticket.devTask). */
  problem?: { actions: { send: (form: FormData) => Promise<void>; status: (form: FormData) => Promise<void>; unlink: (form: FormData) => Promise<void> } };
};

const OVERRIDES = ['none', 'open', 'dialogTitle', 'dialogText', 'apiText', 'submit', 'submitApi', 'refHint', 'statusHint'] as const;

export async function DevTaskBlock({ number, devTask, canManage, canHandOver, mode, problem }: Props) {
  const base = await getTranslations('agent.ticket.devTask');
  const own = await getTranslations('agent.problems.devTask');
  const t = ((key: string, values?: Record<string, string | number>) =>
    problem && (OVERRIDES as readonly string[]).includes(key) ? own(key as (typeof OVERRIDES)[number]) : base(key as Parameters<typeof base>[0], values as never)) as (key: string, values?: Record<string, string | number>) => string;
  const actions = problem?.actions ?? { send: sendToDevAction, status: devTaskStatusAction, unlink: unlinkDevAction };
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
              <form action={actions.status} className="flex flex-col gap-1">
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
                {problem && <p className="text-xs text-muted-foreground">{t('statusHint')}</p>}
                <Button type="submit" variant="secondary">
                  {t('changeStatus')}
                </Button>
              </form>
            )}
            {task.tracker === 'smartup' && <p className="text-xs text-muted-foreground">{t('synced')}</p>}
            {canManage && (
              <form action={actions.unlink}>
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
            mode={mode}
            action={actions.send}
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
              apiText: t('apiText'),
              existingRef: t('existingRef'),
              existingRefHint: t('existingRefHint'),
              submitApi: t('submitApi'),
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
