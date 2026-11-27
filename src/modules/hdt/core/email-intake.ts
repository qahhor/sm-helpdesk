import 'server-only';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { consumeRateLimit, emitEventTx, enqueue, getStorage, rateKey, recordTicketSignature, wakeAutomation, writeAudit } from '@/modules/hdc/api';
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
import { attachments, ticketEvents, ticketMessages, tickets, ticketWatchers } from '../schema';
import { maskCsatLinks } from '../csat-link';
import { staffSystemText } from '../system-text';
import { untrustedNoteText } from '../untrusted-text';
import { fileTypeOf, maxBytesFor, quarantineKey } from '../util';
import { reopenDays } from './actions';
import { aiReopenedTx } from './ai';
import { notifyTicketTx } from './notify';
import { refreshSla } from './sla';
import { isThanks } from './thanks';
import { createEmailTicketTx, ticketExists } from './tickets';
import { startAssistant } from '../api/ai';
import { thanksOnClientReply } from '../api/ai-messages';

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

/**
 * Загрузки письма до транзакции разбора (аудит 23.11.2026, находка P10): строки вложений без обращения и файлы
 * в карантине. Раньше файл клался в хранилище внутри транзакции, под блокировкой обращения и письма: медленное
 * хранилище держало блокировку. Порядок как у загрузки из браузера: строка, файл, затем прикрепление к обращению.
 * Сбой после загрузки оставляет строку без обращения: её вместе с файлом убирает очистка загрузок (sweepAttachments).
 */
async function stageFiles(actor: SystemActor, owner: { orgId: string; uploaderId: string }, files: File[]): Promise<string[]> {
  if (files.length === 0) return [];
  const ids = await withActor(actor, async (tx) => {
    const created: string[] = [];
    for (const file of files) {
      // Ключ строится из идентификатора строки, как у загрузки из браузера (insertUpload).
      const result = await tx.execute<{ attachment_id: string }>(sql`
        insert into hdt_attachments (attachment_id, org_id, uploader_id, storage_key, file_name, mime, size, scan_status)
        select id, ${owner.orgId}::uuid, ${owner.uploaderId}::uuid, 'quarantine/' || id, ${file.fileName}, ${file.mime}, ${file.data.byteLength}, 'pending'
          from (select uuidv7() as id) as generated
        returning attachment_id`);
      const id = result.rows[0]?.attachment_id;
      if (!id) throw new Error('hdt: вложение письма не создано');
      created.push(id);
    }
    return created;
  });
  // Сбой здесь оставляет строки без обращения (и, возможно, часть файлов): их убирает суточная очистка загрузок.
  // Убрать их сразу нельзя: политика базы разрешает удалять только неприкреплённые строки старше суток.
  for (const [index, file] of files.entries()) await getStorage().put(quarantineKey(ids[index] as string), file.data, file.mime);
  return ids;
}

/** Прикрепляет загрузки письма к обращению и сообщению в транзакции разбора. Проверку антивирусом ставит вызывающий после фиксации. */
async function attachStagedTx(tx: Tx, target: { ticketId: string; messageId: string | null }, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const attached = await tx
    .update(attachments)
    .set({ ticketId: target.ticketId, messageId: target.messageId })
    .where(and(inArray(attachments.attachmentId, ids), isNull(attachments.ticketId)))
    .returning({ attachmentId: attachments.attachmentId });
  if (attached.length !== ids.length) throw new Error('hdt: загрузка письма не найдена');
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
  const staged = await stageFiles(actor, { orgId: ticket.orgId, uploaderId: client.userId }, files);
  let attached = false;
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
    queued.push(...(await attachStagedTx(tx, { ticketId: ticket.ticketId, messageId: message.messageId }, staged)));
    attached = true;
    if (!thanks) {
      const waiting = { lastClientMessageOn: sql`now()`, clientWaitingSince: sql`coalesce(${tickets.clientWaitingSince}, now())` };
      const reopens = current.status === 'waiting_customer' || current.status === 'resolved' || current.status === 'closed';
      if (reopens) {
        const diff = { from: current.status, to: 'in_progress', source: 'email' };
        await tx.insert(ticketEvents).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status', actorType: 'client', actorId: client.userId, payload: diff });
        await writeAudit(tx, { action: 'ticket.status_changed', objectType: 'ticket', objectId: ticket.ticketId, orgId: ticket.orgId, diff });
      }
      // События для правил автоматизации (FR-AUTO-02) в порядке действия: ответ клиента, затем смена статуса.
      await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'client_replied', payload: { source: 'email' } });
      if (reopens) await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'status_changed', payload: { from: current.status, to: 'in_progress' } });
      // Отметки ответа, статус и сроки одним обновлением строки (аудит 23.11.2026, находка P8). Строка обращения
      // заблокирована выше, событие статуса уже записано: по его времени снимается пауза срока.
      await refreshSla(tx, ticket.ticketId, new Date(), reopens ? { status: 'in_progress', ...waiting } : waiting);
      // Решённое кнопкой "Помогло" открыто письмом: в "После AI" (независимая проверка M5b, I3).
      if (current.status === 'resolved' || current.status === 'closed') await aiReopenedTx(tx, { ticketId: ticket.ticketId, now: new Date() });
    }
    if (thanks) await emitEventTx(tx, { orgId: ticket.orgId, ticketId: ticket.ticketId, kind: 'client_replied', payload: { source: 'email', thanks: true } });
    await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'client_reply', actorUserId: client.userId });
    if (row.messageId) await recordThreadTx(tx, { ticketId: ticket.ticketId, messageId: row.messageId, inReplyTo: inReplyToOf(letter.headers), direction: 'in' });
    await markInboundTx(tx, row.inboundId, { classification: 'reply', ticketId: ticket.ticketId, headers: letter.headers, dmarcAligned: letter.aligned });
    return 'reply' as const;
  });
  // Итог "reply" мог прийти и от другого процесса, который разобрал письмо раньше: тогда наши загрузки лишние.
  await afterCommit(attached ? queued : []);
  // Благодарность на решённое уточняется у модели (FR-TK-14, план M5b, решение 24), как у ответа в портале.
  if (result === 'reply') await thanksOnClientReply(ticket.ticketId);
  return result;
}

/**
 * Письма сверх предела в обращение не попадают. Чтобы сотрудник знал, что они были, ставится одна сводная внутренняя
 * заметка без текста писем, не чаще раза в час на обращение (проверка волны 1). Уведомлений она не рассылает.
 */
async function heldNote(actor: SystemActor, ticket: Ticket): Promise<void> {
  if (!(await consumeRateLimit(`email-review:held:${ticket.ticketId}`, RATE_RULES.emailReviewHeldNote)).allowed) return;
  const body = staffSystemText(ticket.locale, 'emailHeld', { limit: String(RATE_RULES.emailReviewPerTicket.limit) });
  await withActor(actor, (tx) =>
    tx.insert(ticketMessages).values({ orgId: ticket.orgId, ticketId: ticket.ticketId, authorId: null, authorType: 'system', body, isInternal: true, source: 'email' }),
  );
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

/**
 * Первая ли это попытка разбора письма. Пределы частоты считают письма, а не попытки: повтор фоновой задачи после
 * сбоя (например, хранилище недоступно) предел не расходует, иначе само письмо закрылось бы как rate_limited
 * (итоговая проверка волны 2).
 */
async function firstAttempt(inboundId: string): Promise<boolean> {
  return (await consumeRateLimit(`email-intake:letter:${inboundId}`, RATE_RULES.emailLetterOnce)).allowed;
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
  if (await firstAttempt(letter.row.inboundId)) {
    const limit = await consumeRateLimit(rateKey('email-review:sender', letter.row.fromAddress), RATE_RULES.emailReviewPerSender);
    if (!limit.allowed) return finish(actor, letter, 'rate_limited', ticket.ticketId);
    // И на обращение: адрес отправителя в письме произвольный, предел на адрес обходится сменой адреса (находка S12).
    const perTicket = await consumeRateLimit(`email-review:ticket:${ticket.ticketId}`, RATE_RULES.emailReviewPerTicket);
    if (!perTicket.allowed) {
      await heldNote(actor, ticket);
      return finish(actor, letter, 'rate_limited', ticket.ticketId);
    }
  }
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
  if ((await firstAttempt(row.inboundId)) && !(await consumeRateLimit(limitKey, RATE_RULES.emailTicketPerSender)).allowed) return finish(actor, letter, 'rate_limited');
  const sender = await identifySender(letter);
  // Наблюдатели только у обращения организации: личное коллеги не видят (решение 17 плана M2).
  const watchers = sender.identified ? await colleaguesInCopy(row.ccAddresses, sender.orgId, sender.userId) : [];
  const ack = !sender.identified && (await consumeRateLimit(rateKey('email-ack:sender', row.fromAddress), RATE_RULES.unidentifiedAckPerSender)).allowed;
  const files = await downloadFiles(letter.files);
  const title = cleanSubject(row.subject, sender.locale);
  const queued: string[] = [];
  const staged = await stageFiles(actor, { orgId: sender.orgId, uploaderId: sender.userId }, files);
  let attached = false;
  let created: { ticketId: string; body: string } | null = null;
  const result = await withActor(actor, async (tx) => {
    const done = await alreadyDone(tx, row);
    if (done) return done;
    const body = cut(letter.fullText, BODY_MAX) || title;
    const ticket = await createEmailTicketTx(tx, {
      orgId: sender.orgId,
      authorId: sender.userId,
      title,
      // Пересланное письмо и есть суть нового обращения: цитата не отрезается (итоговая проверка M4).
      body,
      locale: sender.locale,
      visibility: sender.visibility,
      senderUnconfirmed: sender.senderUnconfirmed,
    });
    created = { ticketId: ticket.ticketId, body };
    for (const userId of watchers)
      await tx.insert(ticketWatchers).values({ orgId: sender.orgId, ticketId: ticket.ticketId, userId, source: 'manual' }).onConflictDoNothing();
    queued.push(...(await attachStagedTx(tx, { ticketId: ticket.ticketId, messageId: null }, staged)));
    attached = true;
    if (sender.identified) await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'created', actorUserId: null, viaEmail: true });
    else if (ack) await notifyTicketTx(tx, { ticketId: ticket.ticketId, kind: 'unidentified_ack', actorUserId: null });
    if (row.messageId) await recordThreadTx(tx, { ticketId: ticket.ticketId, messageId: row.messageId, inReplyTo: inReplyToOf(letter.headers), direction: 'in' });
    await markInboundTx(tx, row.inboundId, { classification: 'new', ticketId: ticket.ticketId, headers: letter.headers, dmarcAligned: letter.aligned });
    return 'new' as const;
  });
  // Сигнатура ошибки из текста письма (план M5, задача 8) после фиксации, до разбора правил. Письмо неизвестного
  // отправителя (служебная организация) сигнатуру не получает: оно не прибавило бы организацию к числу клиентов.
  const fresh = created as { ticketId: string; body: string } | null;
  // Неподтверждённый отправитель с домена организации сигнатуру получает, но организацию к числу клиентов не
  // прибавляет: письмо с её домена ещё не значит, что ошибка встретилась у неё (0057, M7m).
  if (result === 'new' && fresh && sender.orgId !== SERVICE_ORG_ID)
    await recordTicketSignature({ ticketId: fresh.ticketId, orgId: sender.orgId, authorId: sender.userId, description: fresh.body, context: null, moduleId: null, countOrg: !sender.senderUnconfirmed });
  // Помощник первой линии только у письма опознанного пользователя с DMARC (план M5b, решение 4; проверка на
  // AI-инъекции, пункт 2): гость с домена организации и "Неопознанные" его не получают.
  if (result === 'new' && fresh && sender.identified) await startAssistant({ ticketId: fresh.ticketId, orgId: sender.orgId });
  await afterCommit(attached ? queued : []);
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
  await wakeAutomation();
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
    // Ссылки оценки из пересланного письма о закрытии в текст обращения и заметки не попадают.
    text: maskCsatLinks(emailToText(content)),
    fullText: maskCsatLinks(emailToText(content, { keepQuote: true })),
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
