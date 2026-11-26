import type { ReactNode } from 'react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { type AgentFileView, type AgentTicketView, type AgentTimelineEntry, earlierLink, TIMELINE_PAGE } from '@/modules/hdt/api';
import { Link } from '@/i18n/navigation';
import { Card, CardContent } from '@/ui/components/card';
import { Markdown } from '@/ui/components/markdown';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { cn } from '@/ui/cn';
import { FlagAiAnswer } from './FlagAiAnswer';
import { translateMessageAction } from './actions';

// Переписка и история обращения у сотрудника (FR-AG-04, UX-A-14, UX-A-15): описание, сообщения с заметками,
// события, файлы. Серверный компонент, скриптов не добавляет. Вынесен из страницы (аудит 23.11.2026, находка A8).

type Props = {
  ticket: AgentTicketView;
  /** Очередь и сортировка, из которых открыто обращение: ссылка "Показать раньше" их сохраняет. */
  from: { queue?: string; sort?: string };
  /** Может ли сотрудник отметить ответ помощника неверным (FR-AI-16): ведёт обращения. */
  canFlag?: boolean;
  /** Машинные переводы сообщений клиента (FR-AG-11): по идентификатору сообщения; canTranslate: кнопка "Перевести". */
  translations?: { canTranslate: boolean; byMessage: Map<string, { status: 'pending' | 'ready' | 'failed'; text: string | null }> };
};

export async function TicketTimeline({ ticket, from, canFlag = false, translations }: Props) {
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const when = (date: Date) => format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
  const statusName = (status: unknown) => (typeof status === 'string' && t.has(`queues.statuses.${status}`) ? t(`queues.statuses.${status}`) : String(status ?? ''));

  const files = (list: AgentFileView[]) =>
    list.length > 0 && (
      <ul className="flex flex-wrap gap-3" aria-label={t('ticket.files')}>
        {list.map((file) => (
          <li key={file.attachmentId} className="flex max-w-full flex-col gap-1 text-sm">
            {file.canOpen ? (
              <span className="flex flex-wrap items-center gap-2">
                <a href={`/api/attachments/${file.attachmentId}`} className="break-all text-link underline-offset-2 hover:underline">
                  {file.fileName}
                </a>
                {file.canPreview && (
                  <a
                    href={`/api/attachments/${file.attachmentId}?inline=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-link underline-offset-2 hover:underline"
                  >
                    {t('ticket.preview')}
                  </a>
                )}
              </span>
            ) : (
              <span className="break-all" data-scan={file.scanStatus}>
                {file.fileName} <span className="text-muted-foreground">({t(`ticket.scan.${file.scanStatus}`)})</span>
              </span>
            )}
            {file.isInternal && <span className="text-xs text-muted-foreground">{t('ticket.internalFile')}</span>}
          </li>
        ))}
      </ul>
    );

  const eventText = (entry: Extract<AgentTimelineEntry, { type: 'event' }>): string => {
    const p = entry.payload;
    const actor = entry.actorName ?? t('ticket.system');
    switch (entry.kind) {
      case 'status':
        return t('ticket.events.status', { actor, from: statusName(p.from), to: statusName(p.to) });
      case 'priority':
        return t('ticket.events.priority', { actor, from: String(p.from ?? '').toUpperCase(), to: String(p.to ?? '').toUpperCase(), reason: String(p.reason ?? '') });
      case 'assignee':
        return p.toName ? t('ticket.events.assignee', { actor, to: String(p.toName) }) : t('ticket.events.unassigned', { actor });
      case 'queue':
        if (p.from !== undefined && p.to === 'l1') return t('ticket.events.returned', { actor, explanation: String(p.explanation ?? '') });
        if (p.from !== undefined)
          return t('ticket.events.transferred', {
            actor,
            reason: t.has(`ticket.transfer.reasons.${String(p.reason)}`) ? t(`ticket.transfer.reasons.${String(p.reason)}`) : String(p.reason ?? ''),
            checked: String(p.checked ?? ''),
            needed: String(p.needed ?? ''),
          });
        return t('ticket.events.queue', { actor, to: t.has(`ticket.lines.${String(p.to)}`) ? t(`ticket.lines.${String(p.to)}`) : String(p.to ?? '') });
      case 'merge':
        return typeof p.from === 'number' ? t('ticket.events.mergedFrom', { actor, number: `SUP-${p.from}` }) : t('ticket.events.merge', { actor });
      case 'tag':
        return t(p.action === 'removed' ? 'ticket.events.tagRemoved' : 'ticket.events.tagAdded', { actor, name: String(p.name ?? '') });
      case 'rule': {
        // Срабатывание правила автоматизации (FR-AUTO-09): название правила и что оно сделало, с прежним и новым значением.
        const label = (action: string, value: unknown): string => {
          if (value === null || value === undefined) return '';
          const text = String(value);
          if (action === 'set_status') return statusName(text);
          if (action === 'set_priority') return text.toUpperCase();
          if (action === 'set_queue') return t.has(`ticket.lines.${text}`) ? t(`ticket.lines.${text}`) : text;
          if (action === 'snooze') return Number.isNaN(Date.parse(text)) ? text : when(new Date(text));
          return text;
        };
        const done = (Array.isArray(p.actions) ? p.actions : []).flatMap((item): string[] => {
          if (item === null || typeof item !== 'object') return [];
          const { action, ok, from, to, unchanged } = item as { action?: unknown; ok?: unknown; from?: unknown; to?: unknown; unchanged?: unknown };
          if (typeof action !== 'string' || !t.has(`ticket.ruleActions.${action}`)) return [];
          if (ok !== true) return [t('ticket.ruleActionFailed', { name: t(`ticket.ruleActionNames.${action}`) })];
          if (unchanged === true) return [`${t(`ticket.ruleActionNames.${action}`)}: ${t('ticket.ruleActions.unchanged')}`];
          // У макроса ответ по шаблону не отправлен, а вставлен в поле ответа: своя подпись.
          const key = p.macro === true && t.has(`ticket.macroActions.${action}`) ? `ticket.macroActions.${action}` : `ticket.ruleActions.${action}`;
          return [t(key, { from: label(action, from), to: label(action, to) }).trim()];
        });
        // Запуск макроса сотрудником (FR-AG-15): та же запись, но с именем сотрудника.
        if (p.macro === true) return t('ticket.events.macro', { actor, name: String(p.ruleName ?? ''), actions: done.join('; ') });
        return t('ticket.events.rule', { name: String(p.ruleName ?? ''), actions: done.join('; ') });
      }
      case 'dev_task': {
        // Задача разработки (FR-DEV): привязана, отвязана, закрыта. Клиент этих записей не видит.
        const ref = String(p.ref ?? '');
        if (p.action === 'closed')
          return t('ticket.events.devTaskClosed', { ref, status: t.has(`ticket.devTask.statuses.${String(p.status)}`) ? t(`ticket.devTask.statuses.${String(p.status)}`) : String(p.status ?? '') });
        return t(p.action === 'unlinked' ? 'ticket.events.devTaskUnlinked' : 'ticket.events.devTaskLinked', { actor, ref });
      }
      case 'ai_handoff':
        // Передача помощником сотруднику (план M5b, задача 7): причина из перечня FR-AI-14.
        return t('ticket.events.ai_handoff', { reason: t.has(`ticket.aiReasons.${String(p.reason)}`) ? t(`ticket.aiReasons.${String(p.reason)}`) : '' });
      case 'due':
        return t('ticket.events.due', { kind: t.has(`ticket.dueKinds.${String(p.kind)}`) ? t(`ticket.dueKinds.${String(p.kind)}`) : '' });
      default:
        return t.has(`ticket.events.${entry.kind}`) ? t(`ticket.events.${entry.kind}`, { actor }) : `${actor}: ${entry.kind}`;
    }
  };

  type Row = { at: Date; key: string; node: ReactNode };
  const rows: Row[] = [
    {
      at: ticket.createdOn,
      key: 'description',
      node: (
        <article className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{ticket.author.name ?? t('ticket.client')}</span>, {when(ticket.createdOn)}
          </p>
          <Markdown text={ticket.description} />
          {files(ticket.attachments)}
        </article>
      ),
    },
    ...ticket.timeline.map((entry): Row => ({
      at: entry.createdOn,
      key: entry.id,
      node:
        entry.type === 'message' ? (
          <article
            className={cn('flex flex-col gap-2 rounded-control p-3', entry.isInternal && 'border border-warning bg-warning-bg')}
            data-internal={entry.isInternal ? '' : undefined}
          >
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {entry.isInternal && <StatusLabel tone="orange">{t('ticket.note')}</StatusLabel>}
              {entry.isAuto && <StatusLabel tone="gray">{t('ticket.auto')}</StatusLabel>}
              <span className="font-semibold text-foreground">{entry.authorName ?? t(`ticket.authors.${entry.authorType}`)}</span>, {when(entry.createdOn)}
              {entry.isNew && <StatusLabel tone="blue">{t('ticket.new')}</StatusLabel>}
              {entry.undelivered && <StatusLabel tone="danger">{t('ticket.undelivered')}</StatusLabel>}
            </p>
            <Markdown text={entry.body} />
            {files(entry.attachments)}
            {entry.authorType === 'client' && !entry.isInternal && translations && (() => {
              const found = translations.byMessage.get(entry.id);
              if (found?.status === 'ready' && found.text)
                return (
                  <section className="flex flex-col gap-1 rounded-control border border-border bg-card-soft p-2 text-sm" data-translation={entry.id}>
                    <p className="flex flex-wrap items-center gap-2">
                      <StatusLabel tone="gray">{t('ticket.translate.machine')}</StatusLabel>
                      <span className="text-xs text-secondary-foreground">{t('ticket.translate.hint')}</span>
                    </p>
                    <p className="whitespace-pre-wrap break-words">{found.text}</p>
                  </section>
                );
              if (found?.status === 'pending') return <p className="text-sm text-secondary-foreground" data-translation-pending>{t('ticket.translate.pending')}</p>;
              if (!translations.canTranslate) return null;
              return (
                <form action={translateMessageAction}>
                  <input type="hidden" name="number" value={ticket.number} />
                  <input type="hidden" name="messageId" value={entry.id} />
                  {found?.status === 'failed' && <span className="me-2 text-sm text-secondary-foreground">{t('ticket.translate.failed')}</span>}
                  <button type="submit" className="text-sm text-link underline-offset-2 hover:underline">
                    {t('ticket.translate.button')}
                  </button>
                </form>
              );
            })()}
            {canFlag && entry.authorType === 'ai' && (entry.aiKind === 'answer' || entry.aiKind === 'clarify') && <FlagAiAnswer number={ticket.number} messageId={entry.id} />}
          </article>
        ) : (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-event={entry.kind}>
            <span>
              -- {eventText(entry)}, {when(entry.createdOn)}
            </span>
            {entry.isNew && <StatusLabel tone="blue">{t('ticket.new')}</StatusLabel>}
          </p>
        ),
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6">
        {earlierLink(ticket.shown, ticket.hasEarlier) === 'limit' && <p className="text-sm text-muted-foreground">{t('ticket.earlierLimit', { count: ticket.shown })}</p>}
        {earlierLink(ticket.shown, ticket.hasEarlier) === 'link' && (
          // История читается частями (аудит 23.11.2026, находка P11): ссылка добавляет ещё 50 записей.
          <Link
            href={`/agent/tickets/SUP-${ticket.number}?${new URLSearchParams({ ...(from.queue ? { queue: from.queue } : {}), ...(from.sort ? { sort: from.sort } : {}), shown: String(ticket.shown + TIMELINE_PAGE) })}`}
            className="self-start text-sm text-link underline-offset-2 hover:underline"
          >
            {t('ticket.showEarlier')}
          </Link>
        )}
        {rows.map((row) => (
          <div key={row.key}>{row.node}</div>
        ))}
      </CardContent>
    </Card>
  );
}
