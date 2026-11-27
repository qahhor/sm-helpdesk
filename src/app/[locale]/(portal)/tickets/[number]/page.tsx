import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getFormatter, getNow, getTranslations } from 'next-intl/server';
import {
  ALLOWED_FILE_EXTENSIONS,
  type AttachmentView,
  CSAT_REASONS,
  findTicketInOtherOrganizations,
  getTicket,
  MAX_FILES_PER_MESSAGE,
  parseNumber,
  TIMELINE_PAGE,
  earlierLink,
} from '@/modules/hdt/api';
import { requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { CopyButton } from '@/ui/components/copy-button';
import { DraftCleaner } from '@/ui/components/draft-cleaner';
import { Markdown } from '@/ui/components/markdown';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { acceptOf, STATUS_TONE } from '../status';
import { switchToTicketAction } from './actions';
import { AiMessage } from './AiMessage';
import { AiThinking } from './AiThinking';
import { ReplyForm } from './ReplyForm';
import { StatusLine } from './StatusLine';
import { TicketActions } from './TicketActions';

// Страница обращения (ТЗ 8.3, FR-TK-07, FR-TK-17): номер копируется одним нажатием, линейка состояния и чей ход,
// переписка в Markdown, файлы с миниатюрами, история статусов в ленте, действия по правам. Невидимое клиенту
// обращение не отличается от несуществующего: страница "не найдено".

/** Номер из адреса. Испорченная последовательность %XX даёт null, а не исключение (ошибку 500). */
/** Подпись состояния файла: у отказа причина, если её можно назвать клиенту (решение 0027, пункт 20). */
function scanLabel(file: Pick<AttachmentView, 'scanStatus' | 'rejectReason'>): string {
  if (file.scanStatus === 'rejected') return file.rejectReason ?? 'rejected';
  return file.scanStatus === 'infected' ? 'infected' : 'pending';
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

type Attachment = Pick<AttachmentView, 'attachmentId' | 'fileName' | 'scanStatus' | 'rejectReason' | 'isImage'>;

export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ done?: string; error?: string; created?: string; shown?: string }>;
}) {
  const client = await requireClientActor();
  const raw = safeDecode((await params).number);
  // Испорченная последовательность %XX в адресе: такого обращения нет.
  if (raw === null) notFound();
  const query = await searchParams;
  const ticket = await getTicket(client, raw, { shown: query.shown });
  const t = await getTranslations('client.tickets');
  const tt = await getTranslations('client.tez');
  if (!ticket) {
    // Обращение другой своей организации: подсказка и переход вместо "не найдено" (UX-C-06).
    const elsewhere = await findTicketInOtherOrganizations(client, raw);
    if (!elsewhere) notFound();
    const label = `SUP-${parseNumber(raw)}`;
    return (
      <>
        <h1 className="text-2xl font-bold">{label}</h1>
        <Alert>{t('page.otherOrg.text', { number: label, org: elsewhere.orgName })}</Alert>
        <form action={switchToTicketAction}>
          <input type="hidden" name="orgId" value={elsewhere.orgId} />
          <input type="hidden" name="number" value={label} />
          <Button type="submit">{t('page.otherOrg.switch', { org: elsewhere.orgName })}</Button>
        </form>
      </>
    );
  }
  const { done, error, created } = query;
  const format = await getFormatter();
  const now = await getNow();
  const when = (date: Date) => format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
  /** Срок в часовом поясе поддержки: "сегодня, 16:30", "завтра, 09:00" или дата со временем (раздел 8.3). */
  const deadline = (at: Date, timeZone: string) => {
    const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const time = format.dateTime(at, { timeZone, hour: '2-digit', minute: '2-digit' });
    if (day(at) === day(now)) return t('page.nextReply.today', { time });
    if (day(at) === day(new Date(now.getTime() + 86_400_000))) return t('page.nextReply.tomorrow', { time });
    return format.dateTime(at, { timeZone, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  };
  const status = (value: string) => t(`statuses.${value}`);
  const label = `SUP-${ticket.number}`;
  const fileErrors = Object.fromEntries(['too_many_files', 'file_not_allowed', 'file_too_large', 'rate_limited', 'upload'].map((code) => [code, t(`errors.${code}`)]));

  const files = (list: Attachment[]) =>
    list.length > 0 && (
      <ul className="flex flex-wrap gap-3" aria-label={t('page.files')}>
        {list.map((file) => (
          <li key={file.attachmentId} className="flex max-w-full flex-col gap-1 text-sm">
            {file.scanStatus === 'clean' ? (
              <a href={`/api/attachments/${file.attachmentId}`} className="flex max-w-full flex-col gap-1 text-link underline-offset-2 hover:underline">
                {file.isImage && (
                  // eslint-disable-next-line @next/next/no-img-element -- картинка приходит перенаправлением на ссылку хранилища на 60 секунд
                  <img src={`/api/attachments/${file.attachmentId}?inline=1`} alt={file.fileName} className="max-h-40 max-w-full rounded-control border border-border object-contain" />
                )}
                <span className="break-all">{file.fileName}</span>
              </a>
            ) : (
              <span className="break-all" data-scan={file.scanStatus}>
                {file.fileName} <span className="text-muted-foreground">({t(`page.scan.${scanLabel(file)}`)})</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    );

  type Entry = { at: Date; key: string; node: ReactNode };
  const lastAiId = ticket.messages.filter((m) => m.authorType === 'ai').at(-1)?.messageId ?? null;
  const authorOf = (m: { isMine: boolean; authorType: string; authorName: string | null }) =>
    m.isMine ? t('page.you') : m.authorType === 'client' ? (m.authorName ?? t('page.colleague')) : t('page.support');
  const entries: Entry[] = [
    {
      at: ticket.createdOn,
      key: 'description',
      node: (
        <article className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{ticket.isMine ? t('page.you') : (ticket.author.name ?? t('page.colleague'))}</span>, {when(ticket.createdOn)}
          </p>
          <Markdown text={ticket.description} />
          {files(ticket.attachments)}
        </article>
      ),
    },
    ...ticket.messages.map((m) => ({
      at: m.createdOn,
      key: m.messageId,
      // Вид Теза только у сообщения с типом автора ai (FR-AI-08, пункт 9 проверки на AI-инъекции): подпись, знак и
      // кнопки рисуются из ссылок сообщения, а не из текста. Текст клиента такого вида не получает никогда.
      node: m.authorType === 'ai' && m.aiPayload ? (
        <AiMessage
          client={client}
          number={ticket.number}
          messageId={m.messageId}
          payload={m.aiPayload}
          createdOn={m.createdOn}
          actionable={m.messageId === lastAiId && ticket.aiState === 'active' && ticket.status === 'waiting_customer'}
          canResolve={ticket.isMine || client.actor.orgRole === 'client_admin'}
          timeZone={ticket.timeZone}
        />
      ) : (
        <article className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{authorOf(m)}</span>, {when(m.createdOn)}
            {/* Ответ правила автоматизации помечен как автоматический (FR-AUTO-11). */}
            {m.isAuto && (
              <>
                {' '}
                <StatusLabel tone="gray">{t('page.autoReply')}</StatusLabel>
              </>
            )}
          </p>
          <Markdown text={m.body} />
          {files(m.attachments)}
        </article>
      ),
    })),
    ...ticket.events
      .filter((e) => e.kind !== 'created')
      .map((e, index) => {
        const text =
          e.kind === 'status'
            ? t('page.events.status', { from: status(String(e.payload.from)), to: status(String(e.payload.to)) })
            : e.kind === 'visibility' || e.kind === 'rated'
              ? t(`page.events.${e.kind}`)
              : e.kind === 'merge'
                ? // Номер основного только если основное видно клиенту (решение 4 плана M3).
                  ticket.mergedInto
                  ? t('page.events.mergedInto', { number: `SUP-${ticket.mergedInto.number}` })
                  : t('page.events.merged')
                : null;
        return {
          at: e.createdOn,
          key: `event-${index}`,
          node: text && (
            <p className="border-s-2 border-border ps-3 text-sm text-muted-foreground">
              {text}, {when(e.createdOn)}
            </p>
          ),
        };
      }),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <>
      <Link href="/tickets" className="self-start text-sm text-link underline-offset-2 hover:underline">
        {t('new.back')}
      </Link>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-secondary-foreground">{label}</span>
          <CopyButton text={label} label={t('page.copy', { number: label })} copiedLabel={t('page.copied')} />
        </div>
        <h1 className="break-words text-2xl font-bold">{ticket.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusLabel tone={STATUS_TONE[ticket.status] ?? 'gray'}>{status(ticket.status)}</StatusLabel>
          <span>{t(`types.${ticket.type}`)}</span>
          <span className="text-muted-foreground">{ticket.visibility === 'org' ? t('page.visibleOrg') : t('page.visiblePrivate')}</span>
        </div>
        {ticket.nextReply && (
          <p className="text-sm" data-next-reply={ticket.nextReply.kind}>
            {t(`page.nextReply.${ticket.nextReply.kind}`, { when: deadline(ticket.nextReply.at, ticket.nextReply.timeZone) })}
          </p>
        )}
        {ticket.createdByStaff && <p className="text-sm text-muted-foreground">{t('page.createdByStaff')}</p>}
        {ticket.merged && (
          <p className="text-sm" data-merged>
            {ticket.mergedInto ? (
              <Link href={`/tickets/SUP-${ticket.mergedInto.number}`} className="text-link underline underline-offset-2">
                {t('page.mergedLink', { number: `SUP-${ticket.mergedInto.number}` })}
              </Link>
            ) : (
              t('page.mergedHidden')
            )}
          </p>
        )}
        {ticket.relatedNumber && (
          <Link href={`/tickets/SUP-${ticket.relatedNumber}`} className="self-start text-sm text-link underline underline-offset-2">
            {t('page.related', { number: `SUP-${ticket.relatedNumber}` })}
          </Link>
        )}
      </div>

      {(created === '1' || done === 'replied') && (
        <DraftCleaner
          userId={client.actor.userId}
          scopes={done === 'replied' ? [`reply-${ticket.number}`] : [ticket.relatedNumber ? `new-ticket-${ticket.relatedNumber}` : 'new-ticket']}
        />
      )}
      {done && t.has(`page.done.${done}`) && <Alert tone="success">{t(`page.done.${done}`)}</Alert>}
      {error && <Alert tone="danger">{t.has(`errors.${error}`) ? t(`errors.${error}`) : t('errors.invalid_input')}</Alert>}

      <StatusLine
        status={ticket.status}
        labels={{
          label: t('page.steps.label'),
          created: t('page.steps.created'),
          work: t('page.steps.work'),
          resolved: t('page.steps.resolved'),
          current: t('page.steps.current'),
          turn: t(`page.turn.${ticket.turn}`),
        }}
      />

      <Card>
        <CardContent className="flex flex-col gap-5 pt-4">
          <h2 className="sr-only">{t('page.history')}</h2>
          {earlierLink(ticket.shown, ticket.hasEarlier) === 'link' && (
            <Link href={`/tickets/SUP-${ticket.number}?shown=${ticket.shown + TIMELINE_PAGE}`} className="self-start text-sm text-link underline-offset-2 hover:underline">
              {t('page.showEarlier')}
            </Link>
          )}
          {earlierLink(ticket.shown, ticket.hasEarlier) === 'limit' && <p className="text-sm text-muted-foreground">{t('page.earlierLimit', { count: ticket.shown })}</p>}
          {entries.map((entry) => (
            <div key={entry.key}>{entry.node}</div>
          ))}
          {ticket.aiThinking && <AiThinking createdOn={ticket.createdOn.toISOString()} labels={{ title: tt('thinking'), hint: tt('thinkingHint') }} />}
        </CardContent>
      </Card>

      {ticket.csat && <p className="text-sm">{t('page.rate.done', { score: ticket.csat.score })}</p>}

      <TicketActions
        number={ticket.number}
        status={ticket.status}
        visibility={ticket.visibility}
        watching={ticket.watching}
        can={ticket.can}
        labels={{
          confirm: t('page.confirm'),
          reopen: t('page.reopen'),
          reopenHint: t('page.reopenHint'),
          reopenClosed: t('page.reopenClosed'),
          createNew: t('page.createNew'),
          toOrg: t('page.toOrg'),
          toPrivate: t('page.toPrivate'),
          watch: t('page.watch'),
          unwatch: t('page.unwatch'),
          rateTitle: t('page.rate.title'),
          rateScore: t('page.rate.score'),
          rateReason: t('page.rate.reason'),
          rateReasonHint: t('page.rate.reasonHint'),
          rateComment: t('page.rate.comment'),
          rateSubmit: t('page.rate.submit'),
          scores: ['1', '2', '3', '4', '5'].map((value) => ({ value, label: t(`page.rate.scores.${value}`) })),
          reasons: CSAT_REASONS.map((value) => ({ value, label: t(`page.rate.reasons.${value}`) })),
        }}
      />

      {ticket.can.reply && (
        <ReplyForm
          userId={client.actor.userId}
          number={ticket.number}
          sent={done === 'replied'}
          accept={acceptOf(ALLOWED_FILE_EXTENSIONS)}
          maxFiles={MAX_FILES_PER_MESSAGE}
          labels={{
            reply: t('page.reply'),
            placeholder: t('page.replyPlaceholder'),
            send: t('page.send'),
            busy: t('files.busy'),
            errors: Object.fromEntries(['invalid_input', 'rate_limited', 'too_many_files', 'transition_refused', 'file_unavailable', 'upload'].map((code) => [code, t(`errors.${code}`)])),
            files: {
              add: t('files.add'),
              hint: t('files.hint'),
              remove: t.raw('files.remove') as string,
              uploading: t.raw('files.uploading') as string,
              ready: t('files.ready'),
              failed: t('files.failed'),
              errors: fileErrors,
            },
          }}
        />
      )}
    </>
  );
}
