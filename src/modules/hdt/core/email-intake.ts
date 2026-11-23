import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { consumeRateLimit, enqueue, getStorage, rateKey, writeAudit } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import {
  classifyAuto,
  cleanSubject,
  downloadInbound,
  emailToText,
  fetchInbound,
  findThreadTicket,
  type InboundAttachment,
  type InboundClass,
  type InboundRow,
  intakeAddresses,
  isBlocked,
  loadInbound,
  lockInboundTx,
  looksLikeReplyAddress,
  markInbound,
  markInboundTx,
  processedTwinTx,
  recordThreadTx,
  referencedIds,
  replyConfig,
  senderAligned,
  signedReplyOf,
} from '@/modules/hdn/api/inbound';
import { isInboundTestSubject } from '@/modules/hdn/api/mail-settings';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import { ensureGuest, findVerifiedUser, orgByEmailDomain, SERVICE_ORG_ID, senderOrg } from '@/modules/hdu/api/guests';
import { mailRecipient, replyRole } from '@/modules/hdu/api/recipients';
import { ALLOWED_FILES, MAX_FILES_PER_MESSAGE, type TicketStatus, type Visibility } from '../pref';
import { ticketEvents, ticketMessages, tickets, ticketWatchers } from '../schema';
import { staffSystemText } from '../system-text';
import { untrustedNoteText } from '../untrusted-text';
import { fileTypeOf, maxBytesFor, quarantineKey } from '../util';
import { reopenDays } from './actions';
import { notifyTicketTx } from './notify';
import { refreshSla } from './sla';
import { isThanks } from './thanks';
import { createEmailTicketTx, ticketExists } from './tickets';

// Модуль hdt, слой core: разбор входящего письма (FR-EM-02, FR-NT-05..08, раздел 11.8, решения 16, 17, 20 вехи M4).
// Порядок: список отклонённых, автоответ и недоставка, затем обращение по подписанному адресу ответа, по In-Reply-To
// и References, по номеру в теме от участника обращения; иначе новое обращение. От имени клиента публикуется только
// письмо с его адреса, прошедшее DMARC, и только в обращение, которое он видит; остальное становится внутренней
// заметкой "Письмо на проверке". Сеть (текст письма, файлы) до транзакции, запись одной транзакцией с отметкой разбора.

/** Предел текста сообщения в базе (hdt_ticket_messages_c2), знаков. */
const BODY_MAX = 20_000;
/** Сколько участников обращения сверять с адресом отправителя. */
const PARTICIPANTS_MAX = 50;
/** Сколько адресов копии сверять с участниками организации (FR-EM-09). */
const CC_MAX = 20;
const TAG = /\[SUP-(\d{1,9})\]/i;
const FILE_NAME_FORBIDDEN = /[\p{Cc}\u2028\u2029/\\]|(?![\u200C\u200D])\p{Cf}/gu;
const EXTENSION_OF: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(ALLOWED_FILES).map(([ext, mime]) => [mime, ext]).reverse());

type Ticket = { ticketId: string; number: number; orgId: string; status: TicketStatus; closedOn: Date | null; locale: string; mergedIntoId: string | null };
type File = { fileName: string; mime: string; data: Uint8Array };
/** text: без цитаты прошлых писем (ответ в обращение); fullText: с цитатой и пересланным (новое обращение). */
/** owner: подтверждённый пользователь с адресом отправителя, если письмо прошло DMARC (решение 11). */
type Letter = {
  row: InboundRow;
  headers: [string, string][];
  aligned: boolean;
  owner: { userId: string; lastOrgId: string | null } | null;
  text: string;
  fullText: string;
  files: InboundAttachment[];
};

const cut = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
};

/** Обращение по идентификатору или номеру; объединённое ведёт в основное (решение 4 плана M3). */
async function findTicket(actor: SystemActor, by: { ticketId: string } | { number: number }): Promise<Ticket | null> {
  return withActor(actor, async (tx) => {
    const select = () =>
      tx
        .select({
          ticketId: tickets.ticketId,
          number: tickets.number,
          orgId: tickets.orgId,
          status: tickets.status,
          closedOn: tickets.closedOn,
          locale: tickets.locale,
          mergedIntoId: tickets.mergedIntoId,
        })
        .from(tickets);
    let row = (await select().where('ticketId' in by ? eq(tickets.ticketId, by.ticketId) : eq(tickets.number, by.number)).limit(1))[0];
    for (let hop = 0; row?.mergedIntoId && hop < 3; hop++) row = (await select().where(eq(tickets.ticketId, row.mergedIntoId)).limit(1))[0];
    return row ?? null;
  });
}

/** Участник обращения (автор или подписчик), чей адрес для писем совпадает с адресом отправителя. */
async function participantByAddress(actor: SystemActor, ticketId: string, address: string): Promise<string | null> {
  const ids = await withActor(actor, async (tx) => {
    const author = await tx.select({ userId: tickets.authorId }).from(tickets).where(eq(tickets.ticketId, ticketId)).limit(1);
    const watchers = await tx.select({ userId: ticketWatchers.userId }).from(ticketWatchers).where(eq(ticketWatchers.ticketId, ticketId)).limit(PARTICIPANTS_MAX);
    return [...new Set([...author, ...watchers].map((r) => r.userId))];
  });
  for (const userId of ids) if ((await mailRecipient(userId))?.address.toLowerCase() === address) return userId;
  return null;
}

/**
 * Актор клиента, от имени которого письмо можно опубликовать (решение 16): адрес отправителя равен адресу
 * пользователя для писем, DMARC пройден, членство действующее и обращение ему видно (политики RLS). Иначе null.
 */
async function publisher(letter: Letter, userId: string, ticket: Ticket): Promise<ClientActor | null> {
  if (!letter.aligned) return null;
  if ((await mailRecipient(userId))?.address.toLowerCase() !== letter.row.fromAddress) return null;
  const role = await replyRole(userId, ticket.orgId);
  if (!role) return null;
  const client: ClientActor = { type: 'client', userId, orgId: ticket.orgId, orgRole: role };
  return (await ticketExists(client, ticket.number)) ? client : null;
}

/** Имя файла вложения: без пути и невидимых знаков; без допустимого расширения берётся расширение по типу. */
function fileNameOf(file: InboundAttachment, index: number): string | null {
  const name = cut(file.filename.replace(FILE_NAME_FORBIDDEN, '').trim(), 255);
  if (name && fileTypeOf(name, file.contentType)) return name;
  const ext = EXTENSION_OF[file.contentType.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (!ext) return null;
  return `${cut(name.replace(/\.[^.]*$/, ''), 200) || `file-${index + 1}`}.${ext}`;
}

/**
 * Вложения и картинки тела письма (FR-EM-08, FR-NT-08): допустимые типы, не больше предела M2 и не больше десяти.
 * Файл, который не скачался, пропускается с записью в журнал процесса: письмо важнее одного файла.
 */
async function downloadFiles(list: InboundAttachment[]): Promise<File[]> {
  const files: File[] = [];
  for (const [index, item] of list.entries()) {
    if (files.length >= MAX_FILES_PER_MESSAGE) break;
    const fileName = fileNameOf(item, index);
    const mime = fileName ? fileTypeOf(fileName, item.contentType) : null;
    if (!fileName || !mime || item.size > maxBytesFor(mime)) continue;
    try {
      files.push({ fileName, mime, data: await downloadInbound(item.downloadUrl, maxBytesFor(mime)) });
    } catch (error) {
      console.error(`Вложение письма не скачано: ${error instanceof Error ? error.message : 'ошибка'}`);
    }
  }
  return files;
}

/** Строки вложений в карантине и файлы в хранилище. Проверку антивирусом ставит вызывающий после фиксации. */
async function attachFilesTx(tx: Tx, target: { orgId: string; ticketId: string; messageId: string | null; uploaderId: string }, files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const file of files) {
    // Ключ строится из идентификатора строки, как у загрузки из браузера (insertUpload).
    const result = await tx.execute<{ attachment_id: string }>(sql`
      insert into hdt_attachments (attachment_id, org_id, ticket_id, message_id, uploader_id, storage_key, file_name, mime, size, scan_status)
      select id, ${target.orgId}::uuid, ${target.ticketId}::uuid, ${target.messageId}::uuid, ${target.uploaderId}::uuid, 'quarantine/' || id,
             ${file.fileName}, ${file.mime}, ${file.data.byteLength}, 'pending'
        from (select uuidv7() as id) as generated
      returning attachment_id`);
    const id = result.rows[0]?.attachment_id;
    if (!id) throw new Error('hdt: вложение письма не создано');
    await getStorage().put(quarantineKey(id), file.data, file.mime);
    ids.push(id);
  }
  return ids;
}

/**
 * Начало транзакции записи: письмо блокируется. Уже разобрано (повтор задачи) или то же письмо разобрано под другой
 * строкой (два адреса поддержки): итог прежнего разбора, ничего не пишется. Иначе null.
 */
async function alreadyDone(tx: Tx, row: InboundRow): Promise<InboundClass | null> {
  const locked = await lockInboundTx(tx, row.inboundId);
  if (!locked) return 'ignored';
  if (locked.processedOn) return locked.classification ?? 'ignored';
  const twin = await processedTwinTx(tx, row);
  if (!twin) return null;
  await markInboundTx(tx, row.inboundId, { classification: twin.classification, ...(twin.ticketId ? { ticketId: twin.ticketId } : {}) });
  return twin.classification;
}

const inReplyToOf = (headers: [string, string][]) => headers.find(([name]) => name.toLowerCase() === 'in-reply-to')?.[1]?.match(/<[^<>\s]+>/)?.[0] ?? null;

/** Сообщение клиента из письма: как ответ в портале (FR-TK-08), с повторным открытием и сроками. */
async function publishReply(actor: SystemActor, letter: Letter, ticket: Ticket, client: ClientActor): Promise<InboundClass> {
  const files = await downloadFiles(letter.files);
  const body = cut(letter.text, BODY_MAX) || files.map((f) => f.fileName).join(', ');
  const { row } = letter;
  if (!body) return finish(actor, letter, 'ignored', ticket.ticketId);
  const queued: string[] = [];
  const result = await withActor(actor, async (tx) => {
    const done = await alreadyDone(tx, row);
    if (done) return done;
    const current = (await tx.select({ status: tickets.status }).from(tickets).where(eq(tickets.ticketId, ticket.ticketId)).limit(1).for('update'))[0];
    if (!current) throw new Error('hdt: обращение письма не найдено');
    // Благодарность на решённое (FR-TK-14): сообщение сохраняется, обращение остаётся решённым.
    const thanks = current.status === 'resolved' && files.length === 0 && isThanks(body);
    const [message] = await tx
      .insert(ticketMessages)
      .values({ orgId: ticket.orgId, ticketId: ticket.ticketId, authorId: client.userId, authorType: 'client', body, source: 'email', emailMessageId: row.messageId, isThanks: thanks })
      .returning({ messageId: ticketMessages.messageId });
    if (!message) throw new Error('hdt: сообщение письма не создано');
    queued.push(...(await attachFilesTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, messageId: message.messageId, uploaderId: client.userId }, files)));
    if (!thanks) {
      const waiting = { lastClientMessageOn: sql`now()`, clientWaitingSince: sql`coalesce(${tickets.clientWaitingSince}, now())` };
      if (current.status === 'waiting_customer' || current.status === 'resolved' || current.status === 'closed') {
        await tx
          .update(tickets)
          .set({ status: 'in_progress', ...waiting })
          .where(and(eq(tickets.ticketId, ticket.ticketId), eq(tickets.status, current.status)));
        const diff = { from: current.status, to: 'in_progress', source: 'email' };
        await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status', actorType: 'client', actorId: client.userId, payload: diff });
        await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff });
      } else await tx.update(tickets).set(waiting).where(eq(tickets.ticketId, ticket.ticketId));
      await refreshSla(tx, ticket.ticketId, new Date());
    }
    await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'client_reply', actorUserId: client.userId });
    if (row.messageId) await recordThreadTx(tx, { ticketId: ticket.ticketId, messageId: row.messageId, inReplyTo: inReplyToOf(letter.headers), direction: 'in' });
    await markInboundTx(tx, row.inboundId, { classification: 'reply', ticketId: ticket.ticketId, headers: letter.headers, dmarcAligned: letter.aligned });
    return 'reply' as const;
  });
  await afterCommit(queued);
  return result;
}

/** "Письмо на проверке" (решение 16, FR-NT-07): внутренняя заметка с адресом отправителя, клиенту ничего. */
async function reviewNote(actor: SystemActor, letter: Letter, ticket: Ticket): Promise<InboundClass> {
  const { row } = letter;
  const note = staffSystemText(ticket.locale, 'emailReview', { address: row.fromAddress });
  const body = cut(letter.text ? `${note}\n\n${untrustedNoteText(letter.text, ticket.locale)}` : note, BODY_MAX);
  return withActor(actor, async (tx) => {
    const done = await alreadyDone(tx, row);
    if (done) return done;
    await tx
      .insert(ticketMessages)
      .values({ orgId: ticket.orgId, ticketId: ticket.ticketId, authorId: null, authorType: 'system', body, isInternal: true, source: 'email', emailMessageId: row.messageId });
    await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'client_reply', actorUserId: null });
    if (row.messageId) await recordThreadTx(tx, { ticketId: ticket.ticketId, messageId: row.messageId, inReplyTo: inReplyToOf(letter.headers), direction: 'in' });
    await markInboundTx(tx, row.inboundId, { classification: 'review', ticketId: ticket.ticketId, headers: letter.headers, dmarcAligned: letter.aligned });
    return 'review' as const;
  });
}

/** Письмо в найденное обращение: публикация от имени клиента или заметка на проверку. */
async function intoTicket(actor: SystemActor, letter: Letter, ticket: Ticket, userId: string | null): Promise<InboundClass> {
  // Закрытое дольше срока повторного открытия не открывается (FR-TK-12): письмо становится новым обращением.
  if (ticket.status === 'closed' && (!ticket.closedOn || Date.now() - ticket.closedOn.getTime() > (await reopenDays()) * 86_400_000))
    return newTicket(actor, letter);
  const client = userId ? await publisher(letter, userId, ticket) : null;
  if (client) return publishReply(actor, letter, ticket, client);
  // Заметки на проверку ограничены: подписанный адрес виден в пересланном письме, адрес участника подделывается
  // (итоговая проверка M4, замечание I11).
  const limit = await consumeRateLimit(rateKey('email-review:sender', letter.row.fromAddress), RATE_RULES.emailReviewPerSender);
  if (!limit.allowed) return finish(actor, letter, 'rate_limited', ticket.ticketId);
  // И на обращение: адрес отправителя в письме произвольный, предел на адрес обходится сменой адреса (находка S12).
  const perTicket = await consumeRateLimit(`email-review:ticket:${ticket.ticketId}`, RATE_RULES.emailReviewPerTicket);
  if (!perTicket.allowed) return finish(actor, letter, 'rate_limited', ticket.ticketId);
  return reviewNote(actor, letter, ticket);
}

type Sender = { orgId: string; userId: string; visibility: Visibility; senderUnconfirmed: boolean; identified: boolean; locale: 'ru' | 'uz' | 'en' };

/**
 * Отправитель нового обращения (FR-EM-03, FR-EM-06, решения 11, 12, 15). Подтверждённый пользователь с DMARC:
 * обращение в его организации от его имени. Домен организации с DMARC: гость в этой организации, личное, отметка
 * "отправитель не подтверждён". Иначе гость служебной организации "Неопознанные". Без DMARC адрес ничего не доказывает.
 */
async function identifySender(letter: Letter): Promise<Sender> {
  const { row, aligned } = letter;
  if (aligned) {
    const user = letter.owner;
    const orgId = user ? await senderOrg(user.userId, user.lastOrgId) : null;
    if (user && orgId)
      return { orgId, userId: user.userId, visibility: 'org', senderUnconfirmed: false, identified: true, locale: (await mailRecipient(user.userId))?.locale ?? 'ru' };
    const domainOrg = await orgByEmailDomain(row.fromAddress.split('@')[1] ?? '');
    if (domainOrg) {
      const { userId } = await ensureGuest(row.fromAddress, row.fromName, domainOrg);
      return { orgId: domainOrg, userId, visibility: 'private', senderUnconfirmed: true, identified: false, locale: 'ru' };
    }
  }
  const { userId } = await ensureGuest(row.fromAddress, row.fromName, SERVICE_ORG_ID);
  return { orgId: SERVICE_ORG_ID, userId, visibility: 'private', senderUnconfirmed: false, identified: false, locale: 'ru' };
}

/** Подтверждённые пользователи из копии, у которых действующее членство в организации обращения (FR-EM-09). */
async function colleaguesInCopy(addresses: string[], orgId: string, authorId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const address of addresses.slice(0, CC_MAX)) {
    const user = await findVerifiedUser(address);
    if (!user || user.userId === authorId || ids.includes(user.userId)) continue;
    if (await replyRole(user.userId, orgId)) ids.push(user.userId);
  }
  return ids;
}

/**
 * Новое обращение из письма (FR-EM-01, FR-EM-05, FR-EM-07, решения 18 и 19). Сверх 10 в час с адреса: rate_limited
 * без обращения. Опознанному письмо "создано" с номером и ссылкой, неопознанному только номер, не чаще раза в час.
 */
async function newTicket(actor: SystemActor, letter: Letter): Promise<InboundClass> {
  const { row } = letter;
  // Предел для подтверждённого клиента с DMARC свой: подделки под его адрес не исчерпывают его (замечание I7).
  const limitKey = letter.owner ? rateKey('email-ticket:user', letter.owner.userId) : rateKey('email-ticket:sender', row.fromAddress);
  const limit = await consumeRateLimit(limitKey, RATE_RULES.emailTicketPerSender);
  if (!limit.allowed) return finish(actor, letter, 'rate_limited');
  const sender = await identifySender(letter);
  // Наблюдатели только у обращения организации: личное коллеги не видят (решение 17 плана M2).
  const watchers = sender.identified ? await colleaguesInCopy(row.ccAddresses, sender.orgId, sender.userId) : [];
  const ack = !sender.identified && (await consumeRateLimit(rateKey('email-ack:sender', row.fromAddress), RATE_RULES.unidentifiedAckPerSender)).allowed;
  const files = await downloadFiles(letter.files);
  const title = cleanSubject(row.subject, sender.locale);
  const queued: string[] = [];
  const result = await withActor(actor, async (tx) => {
    const done = await alreadyDone(tx, row);
    if (done) return done;
    const created = await createEmailTicketTx(tx, {
      orgId: sender.orgId,
      authorId: sender.userId,
      title,
      // Пересланное письмо и есть суть нового обращения: цитата не отрезается (итоговая проверка M4).
      body: cut(letter.fullText, BODY_MAX) || title,
      locale: sender.locale,
      visibility: sender.visibility,
      senderUnconfirmed: sender.senderUnconfirmed,
    });
    for (const userId of watchers)
      await tx.insert(ticketWatchers).values({ orgId: sender.orgId, ticketId: created.ticketId, userId, source: 'manual' }).onConflictDoNothing();
    queued.push(...(await attachFilesTx(tx, { orgId: sender.orgId, ticketId: created.ticketId, messageId: null, uploaderId: sender.userId }, files)));
    if (sender.identified) await notifyTicketTx(tx, { ticketId: created.ticketId, kind: 'created', actorUserId: null, viaEmail: true });
    else if (ack) await notifyTicketTx(tx, { ticketId: created.ticketId, kind: 'unidentified_ack', actorUserId: null });
    if (row.messageId) await recordThreadTx(tx, { ticketId: created.ticketId, messageId: row.messageId, inReplyTo: inReplyToOf(letter.headers), direction: 'in' });
    await markInboundTx(tx, row.inboundId, { classification: 'new', ticketId: created.ticketId, headers: letter.headers, dmarcAligned: letter.aligned });
    return 'new' as const;
  });
  await afterCommit(queued);
  return result;
}

/** Письмо без обращения: отметка разбора. */
async function finish(actor: SystemActor, letter: Pick<Letter, 'row'> & Partial<Letter>, classification: InboundClass, ticketId?: string): Promise<InboundClass> {
  await markInbound(actor, letter.row.inboundId, {
    classification,
    ...(ticketId ? { ticketId } : {}),
    ...(letter.headers ? { headers: letter.headers } : {}),
    ...(letter.aligned !== undefined ? { dmarcAligned: letter.aligned } : {}),
  });
  return classification;
}

/** После фиксации: проверка вложений антивирусом и отправка писем, поставленных в транзакции. */
async function afterCommit(attachmentIds: string[]): Promise<void> {
  for (const attachmentId of attachmentIds) await enqueue('attachment.scan', { attachmentId });
  await wakeOutbox();
}

export async function intakeEmailTx(actor: SystemActor, inboundId: string): Promise<InboundClass> {
  const row = await loadInbound(actor, inboundId);
  if (!row) return 'ignored';
  if (row.processedOn) return row.classification ?? 'ignored';
  const cfg = replyConfig();
  if (!cfg) return finish(actor, { row }, 'ignored');
  const { content, attachments: files } = await fetchInbound(row.rawRef);
  const aligned = senderAligned(content.headers, row.fromAddress);
  const letter: Letter = {
    row,
    headers: content.headers,
    aligned,
    owner: aligned ? await findVerifiedUser(row.fromAddress) : null,
    text: emailToText(content),
    fullText: emailToText(content, { keepQuote: true }),
    files,
  };

  // Проверочное письмо адреса поддержки (FR-EM-13) пришло через переадресацию: экран настроек покажет "получено".
  if (isInboundTestSubject(row.subject)) return finish(actor, letter, 'ignored');
  // Список отклонённых (решение 14), затем автоответ и недоставка (решение 17): сохраняются без обращения и ответа.
  // Письмо подтверждённого клиента с DMARC список не задевает: адрес могли отметить спамом по подделке под него
  // (итоговая проверка M4, замечание I7).
  if (!letter.owner && (await withActor(actor, (tx) => isBlocked(tx, row.fromAddress)))) return finish(actor, letter, 'spam');
  const auto = classifyAuto(letter.headers, row.fromAddress, row.subject);
  if (auto) return finish(actor, letter, auto);

  // Первое правило FR-EM-02: подписанный адрес ответа. Неверная подпись без другого адреса приёма: письмо отброшено.
  const recipients = [...row.toAddresses, ...row.ccAddresses];
  const signed = signedReplyOf(recipients, cfg);
  if (signed) {
    const ticket = await findTicket(actor, { number: signed.number });
    if (!ticket) return finish(actor, letter, 'ignored');
    return intoTicket(actor, letter, ticket, signed.userId);
  }
  if (recipients.some((address) => looksLikeReplyAddress(address, cfg)) && (await intakeAddresses(recipients, cfg)).length === 0)
    return finish(actor, letter, 'ignored');

  // Второе правило: In-Reply-To и References на письмо обращения (решение 20).
  const threadTicketId = await withActor(actor, (tx) => findThreadTicket(tx, referencedIds(letter.headers)));
  const threaded = threadTicketId ? await findTicket(actor, { ticketId: threadTicketId }) : null;
  if (threaded) return intoTicket(actor, letter, threaded, await participantByAddress(actor, threaded.ticketId, row.fromAddress));

  // Третье правило: номер в теме, только от участника обращения. От чужого письмо становится новым обращением.
  const tag = TAG.exec(row.subject);
  const tagged = tag ? await findTicket(actor, { number: Number(tag[1]) }) : null;
  if (tagged) {
    const participant = await participantByAddress(actor, tagged.ticketId, row.fromAddress);
    if (participant) return intoTicket(actor, letter, tagged, participant);
  }
  return newTicket(actor, letter);
}
