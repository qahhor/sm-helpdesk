'use client';

import { Paperclip } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { FilePicker } from '@/ui/components/file-picker';
import { Label } from '@/ui/components/label';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Textarea } from '@/ui/components/textarea';
import { STATUS_TONE } from '@/ui/ticket-status';
import { useWidget } from './session';
import { type TezAi, TezMessage } from './TezMessage';

// Обращение в виджете (план M6, задача 6; решение 13): переписка, ответ с файлами, вложения и подтверждение решения.
// Остальное (подписки, видимость, оценка с причиной, повторное открытие) по ссылке "Открыть в портале" в новой
// вкладке с обычным входом. Данные только клиентской проекции (GET /api/embed/tickets/{номер}); ответ сотрудника
// подписан "Поддержка Smartup" без имени. Ответ AI-помощника (автор ai) рисуется видом Теза с кнопками (волна 7, T1;
// FR-AI-08): клиент видит, что ответил AI, а не сотрудник.

type Attachment = { attachmentId: string; fileName: string; size: number; scanStatus: string; isImage: boolean };
type Message = { messageId: string; authorType: 'client' | 'support' | 'ai'; authorName: string | null; isMine: boolean; isAuto: boolean; body: string; createdOn: string; attachments: Attachment[]; ai?: TezAi };
type Ticket = {
  number: number;
  title: string;
  description: string;
  status: string;
  createdOn: string;
  turn: 'client' | 'support' | 'none';
  attachments: Attachment[];
  messages: Message[];
  can: { reply: boolean; confirm: boolean };
  timeZone: string;
};

export function TicketView({ number, accept, maxFiles }: { number: number; accept: string; maxFiles: number }) {
  const w = useWidget();
  const l = w.labels;
  const [ticket, setTicket] = useState<Ticket | null | 'missing'>(null);
  const [body, setBody] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  // Язык текста решения в ответе помощника: язык страницы виджета.
  const path = `/api/embed/tickets/${number}?locale=${encodeURIComponent(w.locale)}`;

  useEffect(() => {
    let live = true;
    w.request(path)
      .then(async (response) => (response.ok ? ((await response.json()) as Ticket) : ('missing' as const)))
      .catch(() => 'missing' as const)
      .then((loaded) => live && setTicket(loaded));
    return () => {
      live = false;
    };
    // Обращение загружается при открытии экрана.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const response = await w.request(path, { body: payload }).catch(() => null);
    setBusy(false);
    if (!response) return setError(l['panel.offline'] ?? '');
    if (response.ok) {
      setTicket((await response.json()) as Ticket);
      setBody('');
      setAttachmentIds([]);
      setPickerKey((k) => k + 1);
      return;
    }
    const code = ((await response.json().catch(() => null)) as { code?: string } | null)?.code ?? '';
    setError(l[`errors.${code}`] ?? l['report.errors.failed'] ?? '');
  };

  // Файл: ссылка хранилища на 60 секунд по токену виджета, открывается в новой вкладке.
  const openFile = async (attachment: Attachment) => {
    const response = await w.request(`/api/attachments/${attachment.attachmentId}`).catch(() => null);
    const url = response?.ok ? ((await response.json()) as { url?: string }).url : undefined;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  const files = (list: Attachment[]) =>
    list.length > 0 && (
      <ul className="flex flex-col gap-1">
        {list.map((a) => (
          <li key={a.attachmentId} className="flex items-center gap-2 text-sm">
            <Paperclip className="size-4 shrink-0 text-secondary-foreground" aria-hidden />
            {a.scanStatus === 'clean' ? (
              <button type="button" className="break-all text-link underline-offset-2 hover:underline" onClick={() => void openFile(a)}>
                {a.fileName}
              </button>
            ) : (
              <span className="break-all">
                {a.fileName} ({l[`page.scan.${a.scanStatus}`] ?? a.scanStatus})
              </span>
            )}
          </li>
        ))}
      </ul>
    );

  const back = (
    <Button variant="ghost" size="small" className="self-start" onClick={w.nav.tickets}>
      {l['tickets.back']}
    </Button>
  );
  if (ticket === null) return <p role="status" className="text-secondary-foreground">{l['panel.waiting']}</p>;
  if (ticket === 'missing')
    return (
      <section className="flex flex-col gap-3">
        {back}
        <Alert>{l['tickets.notFound']}</Alert>
      </section>
    );

  return (
    <article className="flex flex-col gap-4" data-testid="widget-ticket">
      {back}
      <header className="flex flex-col gap-1">
        <p className="text-sm text-secondary-foreground">SUP-{ticket.number}</p>
        <h1 className="text-xl font-bold break-words">{ticket.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <StatusLabel tone={STATUS_TONE[ticket.status] ?? 'gray'}>{l[`statuses.${ticket.status}`]}</StatusLabel>
          <span className="text-sm text-secondary-foreground">{l[`page.turn.${ticket.turn}`]}</span>
        </div>
      </header>
      <p className="whitespace-pre-wrap break-words">{ticket.description}</p>
      {files(ticket.attachments)}

      {ticket.messages.length > 0 && (
        <section className="flex flex-col gap-3" aria-label={l['page.history']}>
          {ticket.messages.map((m) =>
            // Вид Теза только у сообщения с автором ai и данными ответа: из данных проекции, а не из текста.
            m.authorType === 'ai' && m.ai ? (
              <TezMessage key={m.messageId} messageId={m.messageId} ai={m.ai} createdOn={m.createdOn} timeZone={ticket.timeZone} busy={busy} onFeedback={(feedback) => void act({ action: 'ai_feedback', ...feedback })} />
            ) : (
            <div key={m.messageId} className="flex flex-col gap-1 rounded-card border border-border bg-card p-3" data-author={m.authorType}>
              <p className="text-sm font-semibold">
                {m.isMine ? l['page.you'] : m.authorType === 'support' ? l['page.support'] : (m.authorName ?? l['page.colleague'])}
                {m.isAuto && <span className="font-normal text-secondary-foreground"> · {l['page.autoReply']}</span>}
              </p>
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              {files(m.attachments)}
            </div>
            ),
          )}
        </section>
      )}

      {error && <Alert tone="danger">{error}</Alert>}
      {ticket.can.confirm && (
        <Button disabled={busy} onClick={() => void act({ action: 'confirm' })}>
          {l['page.confirm']}
        </Button>
      )}
      {ticket.can.reply && (
        <form
          className="flex flex-col gap-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() !== '') void act({ action: 'reply', body, attachmentIds });
          }}
        >
          <Label htmlFor="widget-reply">{l['page.reply']}</Label>
          <Textarea id="widget-reply" value={body} maxLength={20000} placeholder={l['page.replyPlaceholder']} onChange={(event) => setBody(event.target.value)} />
          <FilePicker
            key={pickerKey}
            accept={accept}
            maxFiles={maxFiles}
            labels={{
              add: l['files.add'] ?? '',
              hint: l['files.hint'] ?? '',
              remove: l['files.remove'] ?? '',
              uploading: l['files.uploading'] ?? '',
              ready: l['files.ready'] ?? '',
              failed: l['files.failed'] ?? '',
              errors: Object.fromEntries(['too_many_files', 'file_not_allowed', 'file_too_large', 'rate_limited', 'upload'].map((code) => [code, l[`errors.${code}`] ?? ''])),
            }}
            onBusyChange={setUploading}
            onReadyChange={setAttachmentIds}
            requestHeaders={w.authHeaders}
          />
          <Button type="submit" disabled={busy || uploading || body.trim() === ''}>
            {l['page.send']}
          </Button>
        </form>
      )}
      <a href={w.nav.portalHref(`/tickets/SUP-${ticket.number}`)} target="_blank" rel="noopener noreferrer" className="text-link underline-offset-2 hover:underline">
        {l['panel.openPortal']}
      </a>
    </article>
  );
}
