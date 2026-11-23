import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { type StaffActor, type SystemActor, withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import type { Locale } from '@/i18n/locales';
import { type ContactDirectory, contacts, enqueue } from '@/modules/hdc/api';
import { replyAddress, replyConfigOf } from '../inbound/reply-address';
import { type MailData, type MailPayload, type MailTemplate, renderMail } from '../mail/render';
import { type DeliveryEvent, type EmailProvider, getEmailProvider } from '../provider';
import { MailError } from '../resend';
import { outbox } from '../schema';
import { getTelegramBot, TelegramError } from '../telegram';
import { recordThreadTx } from './inbound';
import { oncallEmails, shownSupportAddress } from './mail-settings';
import { isTelegramPayload, telegramNoticeText } from './telegram-text';

// Модуль hdn, слой core: очередь исходящих (FR-NT-09, решения 1-3 вехи M4).
// Строка ставится в транзакции действия (enqueueTx). Отправка в три шага: короткая транзакция захватывает пачку
// строк (FOR UPDATE SKIP LOCKED, попытка +1, срок захвата 5 минут), письмо уходит вне транзакции с ключом
// идемпотентности строки, итог пишется отдельной транзакцией. Процесс упал после отправки: строка вернётся после
// срока захвата, а сервис не отправит повтор с тем же ключом.

/** Паузы перед повторами после сбоя, минут. После шестой неудачи строка получает failed. */
export const OUTBOX_RETRY_MINUTES = [1, 5, 15, 60, 240] as const;
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_RETRY_MINUTES.length + 1;
const LEASE_MS = 5 * 60_000;
const BATCH = 50;
const MINUTE = 60_000;
/** Письма клиенту об обращении: на них отвечают, ответ попадает в обращение. */
const CLIENT_REPLY_TEMPLATES = new Set(['ticket_created', 'ticket_reply', 'ticket_status', 'ticket_resolved', 'waiting_reminder', 'unidentified_ack']);

export type OutboxItem = {
  channel: 'email' | 'telegram';
  recipient: { kind: 'user'; userId: string } | { kind: 'oncall' };
  template: MailTemplate;
  /** Данные шаблона. Ссылка, начинающаяся с "/", получает адрес портала и язык получателя при отправке. */
  payload: MailPayload;
  ticketId?: string;
  messageId?: string;
  /** Язык обращения: письмо уходит на языке получателя, а если он не выбран, на этом. */
  locale?: Locale;
  /** Путь настроек уведомлений для отключаемого письма ("/settings" или "/agent/account"). */
  settingsPath?: string;
  /**
   * Письмо запасное к строке Telegram с этим идентификатором (решение 0036, пункт 3): ждёт TELEGRAM_FALLBACK_MINUTES
   * и уходит, только если строка Telegram не отправлена.
   */
  fallbackFor?: string;
};

/** Сколько минут запасное письмо ждёт сообщения в Telegram. */
export const TELEGRAM_FALLBACK_MINUTES = 5;

/** Сообщение в служебный чат дежурных (решение 8). null: чат не настроен, сообщение пропускается. */
export type OncallSender = { send(text: string): Promise<void> };

export async function enqueueTx(tx: Tx, item: OutboxItem): Promise<string> {
  if (item.payload.template !== item.template) throw new Error('очередь: шаблон не совпадает с данными');
  // Идентификатор задаёт приложение: под клиентом строка очереди не читается, RETURNING ей недоступен.
  const outboxId = randomUUID();
  // В строке Telegram текст ответа сотрудника не хранится: в сообщение он не идёт (FR-NT-15, решение 2 вехи M4b).
  const payload = item.channel === 'telegram' && 'body' in item.payload ? { ...item.payload, body: '' } : item.payload;
  await tx.insert(outbox).values({
    outboxId,
    channel: item.channel,
    recipientKind: item.recipient.kind,
    recipientUserId: item.recipient.kind === 'user' ? item.recipient.userId : null,
    template: item.template,
    locale: item.locale ?? null,
    settingsPath: item.settingsPath ?? null,
    payload: payload as unknown as Record<string, unknown>,
    ticketId: item.ticketId ?? null,
    messageId: item.messageId ?? null,
    ...(item.fallbackFor
      ? { fallbackFor: item.fallbackFor, nextAttemptOn: sql`now() + make_interval(mins => ${TELEGRAM_FALLBACK_MINUTES})` }
      : {}),
  });
  return outboxId;
}

/** Будит отправку после фиксации. Сбой постановки не бросает: строку подберёт задача раз в минуту. */
export async function wakeOutbox(): Promise<void> {
  await enqueue('outbox.dispatch', {});
}

type Row = typeof outbox.$inferSelect;
/** messageId: наш Message-ID первого письма строки, для цепочки ответов (решение 20). */
type Outcome = { kind: 'sent'; externalId: string; recipient: string; messageId?: string } | { kind: 'skipped' } | { kind: 'error'; error: string };

/** Код ошибки без адреса, темы и текста письма (проверка main, Q16). */
function errorCode(error: unknown): string {
  if (error instanceof MailError || error instanceof TelegramError) return error.status === null ? 'нет ответа' : `код ${error.status}`;
  return error instanceof Error ? error.name : 'ошибка';
}

/** Ссылки вида "/tickets/1042" получают адрес портала и язык получателя. */
function absolute(payload: Record<string, unknown>, hubUrl: string, locale: Locale): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) out[key] = key === 'url' && typeof value === 'string' && value.startsWith('/') ? `${hubUrl}/${locale}${value}` : value;
  return out;
}

/**
 * Сообщение клиенту в Telegram основным ботом портала (план M4b, решения 1, 2 и 5). Чат и язык берутся в момент
 * отправки: отвязал или заблокировал бота, строка пропускается. Ответ 403 значит, что человек заблокировал бота:
 * привязка получает отметку, повторов нет. Остальные сбои (429, нет ответа) уходят в обычные повторы очереди.
 */
async function deliverTelegram(row: Row, run: RunMemo): Promise<Outcome> {
  const bot = getTelegramBot();
  const payload = row.payload as unknown as MailPayload;
  if (!bot.enabled || !row.recipientUserId || !isTelegramPayload(payload)) return { kind: 'skipped' };
  const chat = await run.telegramChat(row.recipientUserId);
  if (!chat) return { kind: 'skipped' };
  const notice = telegramNoticeText(payload, chat.locale ?? row.locale ?? 'ru', getEnv().HUB_URL);
  try {
    await bot.sendMessage(chat.chatId, notice.text, { linkButton: notice.button });
  } catch (error) {
    if (!(error instanceof TelegramError) || error.status !== 403) throw error;
    await contacts().markTelegramBlocked(chat.chatId);
    return { kind: 'skipped' };
  }
  return { kind: 'sent', externalId: `telegram-${row.outboxId}`, recipient: 'telegram' };
}

/** Одно чтение на запуск: значение запоминается вместе с ожиданием, одновременные отправки ждут один запрос. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    if (!value) {
      const loading = load();
      value = loading;
      // Отказ не запоминается: иначе одно неудачное чтение провело бы через ошибку всю очередь запуска.
      loading.catch(() => {
        if (value === loading) value = undefined;
      });
    }
    return value;
  };
}

/** То же по ключу: адрес и чат получателя читаются один раз на запуск, сколько бы писем ему ни шло. */
function oncePerKey<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const values = new Map<string, Promise<T>>();
  return (key) => {
    let value = values.get(key);
    if (!value) {
      const loading = load(key);
      values.set(key, (value = loading));
      loading.catch(() => {
        if (values.get(key) === loading) values.delete(key);
      });
    }
    return value;
  };
}

/**
 * Память одного запуска отправки (аудит 23.11.2026, находка P7): настройки и адреса получателей раньше читались
 * на каждое письмо. Живёт один запуск, не дольше бюджета времени: изменение адреса или настройки подхватит следующий.
 */
type RunMemo = {
  mailRecipient: ContactDirectory['mailRecipient'];
  telegramChat: ContactDirectory['telegramChat'];
  supportAddress: () => Promise<string | null>;
  oncallEmails: () => Promise<string[]>;
  oncall: () => Promise<OncallSender | null>;
};

function runMemo(oncall: OncallSender | null | undefined): RunMemo {
  return {
    mailRecipient: oncePerKey((userId) => contacts().mailRecipient(userId)),
    telegramChat: oncePerKey((userId) => contacts().telegramChat(userId)),
    supportAddress: once(shownSupportAddress),
    oncallEmails: once(oncallEmails),
    // Бот и чат дежурных берутся из настроек в момент отправки (решение 8), только если такие строки есть.
    oncall: once(async () => (oncall !== undefined ? oncall : (await import('./oncall')).oncallSender())),
  };
}

async function deliver(row: Row, provider: EmailProvider, run: RunMemo): Promise<Outcome> {
  const env = getEnv();
  if (row.channel === 'telegram' && row.recipientKind === 'user') return deliverTelegram(row, run);
  if (row.channel === 'telegram') {
    const oncall = await run.oncall();
    if (!oncall) return { kind: 'skipped' };
    const { oncallTelegramText } = await import('./oncall-text');
    await oncall.send(oncallTelegramText(row.payload, env.HUB_URL));
    return { kind: 'sent', externalId: `telegram-${row.outboxId}`, recipient: 'oncall' };
  }
  let targets: { address: string; locale: Locale }[];
  if (row.recipientKind === 'user' && row.recipientUserId) {
    const to = await run.mailRecipient(row.recipientUserId);
    targets = to ? [{ address: to.address, locale: to.locale ?? row.locale ?? 'ru' }] : [];
  } else targets = (await run.oncallEmails()).map((address) => ({ address, locale: row.locale ?? 'ru' }));
  if (targets.length === 0) return { kind: 'skipped' };
  const supportAddress = await run.supportAddress();
  const reply = replyConfigOf(env);
  const domain = reply?.domain ?? env.HUB_DOMAIN;
  // Ответ на письмо об обращении попадает в обращение: адрес подписан для пары обращение и получатель (FR-NT-06).
  const number = typeof row.payload.number === 'number' ? row.payload.number : null;
  const replyTo =
    reply && number && row.ticketId && row.recipientKind === 'user' && row.recipientUserId && CLIENT_REPLY_TEMPLATES.has(row.template)
      ? replyAddress(number, row.recipientUserId, reply)
      : undefined;
  let externalId = '';
  // Ошибка одного адреса не останавливает остальные (M4, мелкое 4): строка уйдёт в повтор, уже отправленные адреса
  // сервис не повторит по тому же ключу.
  let failure: unknown = null;
  for (const [index, target] of targets.entries()) {
    try {
      const data = {
        ...absolute(row.payload, env.HUB_URL, target.locale),
        hubUrl: env.HUB_URL,
        supportAddress,
        settingsUrl: row.settingsPath ? `${env.HUB_URL}/${target.locale}${row.settingsPath}` : null,
      } as unknown as MailData;
      const mail = await renderMail(row.template as MailTemplate, target.locale, data);
      const key = index === 0 ? row.outboxId : `${row.outboxId}-${index}`;
      const result = await provider.send(
        {
          to: target.address,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          ...(replyTo ? { replyTo } : {}),
          headers: {
            // Наши письма не ждут автоответов (решение 17), у письма свой Message-ID для цепочки (решение 20).
            'Auto-Submitted': 'auto-generated',
            'X-Auto-Response-Suppress': 'All',
            'Message-ID': `<${key}@${domain}>`,
          },
        },
        key,
      );
      if (index === 0) externalId = result.providerId;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return { kind: 'sent', externalId, recipient: targets.map((t) => t.address).join(', ').slice(0, 320), messageId: `<${row.outboxId}@${domain}>` };
}

/** Окно счёта сбоев отправки для наблюдения и сигнала дежурным. */
export const OUTBOX_FAILED_WINDOW_MS = 60 * 60_000;

/**
 * Сбой отправки самого портала: строка исчерпала повторы и не ушла (sent_on пуст). Отказ почтового сервера у уже
 * отправленного письма сюда не входит: его видно на обращении отметкой "Письмо не доставлено" (ТЗ 13.8).
 */
const dispatchFailed = (since: Date) => and(eq(outbox.status, 'failed'), isNull(outbox.sentOn), gt(outbox.modifiedOn, since));

/**
 * Состояние очереди для наблюдения (аудит 23.11.2026, O1): сколько строк ждёт, сколько не отправлено за последний час
 * и сколько секунд ждёт самая старая строка, срок отправки которой уже наступил. Пауза перед повтором задержкой не
 * считается; старые сбои из счёта уходят, иначе событие предупреждало бы вечно (итоговая проверка W0, I2).
 */
export async function outboxState(actor: SystemActor, now: Date): Promise<{ queued: number; failed: number; lagSec: number }> {
  const since = new Date(now.getTime() - OUTBOX_FAILED_WINDOW_MS);
  const rows = await withActor(actor, (tx) =>
    tx
      .select({
        queued: sql<number>`count(*) filter (where ${outbox.status} = 'queued')::int`,
        failed: sql<number>`count(*) filter (where ${outbox.status} = 'failed')::int`,
        oldest: sql<string | null>`min(${outbox.nextAttemptOn}) filter (where ${outbox.status} = 'queued' and ${outbox.nextAttemptOn} <= ${now})::text`,
      })
      .from(outbox)
      .where(or(eq(outbox.status, 'queued'), dispatchFailed(since))),
  );
  const row = rows[0];
  const lagSec = row?.oldest ? Math.max(0, Math.round((now.getTime() - new Date(row.oldest).getTime()) / 1000)) : 0;
  return { queued: row?.queued ?? 0, failed: row?.failed ?? 0, lagSec };
}

/** Сообщения, отправка которых исчерпала повторы, с этого времени. */
export async function outboxFailedSince(actor: SystemActor, since: Date): Promise<number> {
  const rows = await withActor(actor, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(outbox).where(dispatchFailed(since)));
  return rows[0]?.n ?? 0;
}

async function telegramDelivered(actor: SystemActor, outboxId: string): Promise<boolean> {
  const rows = await withActor(actor, (tx) => tx.select({ status: outbox.status }).from(outbox).where(eq(outbox.outboxId, outboxId)).limit(1));
  return rows[0]?.status === 'sent' || rows[0]?.status === 'delivered';
}

/** Одновременных отправок в одном запуске. Больше не нужно: почтовый сервис ограничивает частоту запросов. */
const DISPATCH_CONCURRENCY = 4;
/** Бюджет времени запуска: задача по расписанию идёт раз в минуту, следующий запуск не должен догнать этот. */
const DISPATCH_BUDGET_MS = 50_000;

export type DispatchOptions = { budgetMs?: number; concurrency?: number; clock?: () => number };

/**
 * Отправляет очередь: берёт пачку, шлёт несколько писем одновременно и повторяет, пока очередь не опустеет или не
 * кончится бюджет времени (аудит 23.11.2026, находка P7: раньше одна пачка в 50 писем на запуск, 3000 в час).
 * Строки, взятые в пачку, но не начатые до конца бюджета, возвращаются в очередь без потраченной попытки и без
 * отсрочки: срок захвата иначе держал бы их 5 минут (M4, мелкое 2).
 */
export async function dispatchOutbox(
  actor: SystemActor,
  now: Date,
  provider?: EmailProvider,
  oncall?: OncallSender | null,
  opts: DispatchOptions = {},
): Promise<{ sent: number; failed: number; skipped: number }> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? DISPATCH_BUDGET_MS);
  const concurrency = Math.max(1, opts.concurrency ?? DISPATCH_CONCURRENCY);
  const result = { sent: 0, failed: 0, skipped: 0 };
  const run = runMemo(oncall);
  let email: EmailProvider | undefined = provider;

  while (clock() < deadline) {
    const claimed = await claimBatch(actor, now);
    if (claimed.length === 0) break;
    email ??= await getEmailProvider();
    const mailer = email;
    const untouched: string[] = [];
    // Общая очередь прохода: каждый из исполнителей берёт следующую строку, пока есть время.
    const drain = async (waiting: Row[]) => {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, waiting.length) }, async () => {
          for (let row = waiting.shift(); row; row = waiting.shift()) {
            if (clock() >= deadline) untouched.push(row.outboxId);
            else await sendRow(actor, now, row, mailer, run, result);
          }
        }),
      );
    };
    // Запасные письма идут вторым проходом: к этому времени итог сообщения Telegram из той же пачки уже записан,
    // и письмо не уходит вместе с ним (итоговая проверка волны 2).
    await drain(claimed.filter((row) => !row.fallbackFor));
    await drain(claimed.filter((row) => row.fallbackFor));
    if (untouched.length > 0) {
      await withActor(actor, (tx) =>
        tx
          .update(outbox)
          .set({ attempts: sql`${outbox.attempts} - 1`, nextAttemptOn: now })
          .where(and(inArray(outbox.outboxId, untouched), eq(outbox.status, 'queued'))),
      );
      break;
    }
  }
  return result;
}

/** Захват пачки: строки помечаются попыткой и сроком захвата, другой запуск их не возьмёт. */
async function claimBatch(actor: SystemActor, now: Date): Promise<Row[]> {
  return withActor(actor, async (tx) => {
    const rows = await tx
      .select()
      .from(outbox)
      .where(and(eq(outbox.status, 'queued'), lte(outbox.nextAttemptOn, now)))
      .orderBy(asc(outbox.nextAttemptOn))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    if (rows.length === 0) return [];
    await tx
      .update(outbox)
      .set({ attempts: sql`${outbox.attempts} + 1`, nextAttemptOn: new Date(now.getTime() + LEASE_MS) })
      .where(inArray(outbox.outboxId, rows.map((r) => r.outboxId)));
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
}

/** Отправка одной строки и запись итога. Ошибка остаётся в строке: остальные письма пачки идут дальше. */
async function sendRow(actor: SystemActor, now: Date, row: Row, email: EmailProvider, run: RunMemo, result: { sent: number; failed: number; skipped: number }): Promise<void> {
  let outcome: Outcome;
  try {
    // Запасное письмо не нужно, если сообщение в Telegram уже ушло.
    outcome = row.fallbackFor && (await telegramDelivered(actor, row.fallbackFor)) ? { kind: 'skipped' } : await deliver(row, email, run);
  } catch (error) {
    outcome = { kind: 'error', error: errorCode(error) };
  }
  // Итог пишется только в строку, которая ещё ждёт: если срок захвата истёк и строку отметил другой процесс,
  // его запись не перетирается (M4, мелкое 2).
  const queuedRow = and(eq(outbox.outboxId, row.outboxId), eq(outbox.status, 'queued'));
  await withActor(actor, async (tx) => {
    if (outcome.kind === 'sent') {
      result.sent++;
      const marked = await tx
        .update(outbox)
        .set({ status: 'sent', externalId: outcome.externalId, recipient: outcome.recipient, sentOn: now, lastError: null })
        .where(queuedRow)
        .returning({ outboxId: outbox.outboxId });
      // Ответ на наше письмо без адреса ответа найдёт обращение по In-Reply-To (решение 20, итоговая проверка M4).
      if (marked.length > 0 && row.ticketId && outcome.messageId) await recordThreadTx(tx, { ticketId: row.ticketId, messageId: outcome.messageId, direction: 'out' });
    } else if (outcome.kind === 'skipped') {
      result.skipped++;
      await tx.update(outbox).set({ status: 'skipped' }).where(queuedRow);
    } else if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
      result.failed++;
      await tx.update(outbox).set({ status: 'failed', lastError: outcome.error }).where(queuedRow);
    } else {
      const pause = OUTBOX_RETRY_MINUTES[row.attempts - 1] ?? OUTBOX_RETRY_MINUTES[OUTBOX_RETRY_MINUTES.length - 1];
      await tx
        .update(outbox)
        .set({ lastError: outcome.error, nextAttemptOn: new Date(now.getTime() + pause * MINUTE) })
        .where(queuedRow);
    }
  });
}

/** События доставки (решение 21): статус строки по идентификатору письма у сервиса. */
export async function recordDelivery(actor: SystemActor, event: DeliveryEvent): Promise<void> {
  await withActor(actor, async (tx) => {
    const byId = eq(outbox.externalId, event.emailId);
    switch (event.status) {
      case 'sent':
        return;
      case 'delivered':
        await tx.update(outbox).set({ status: 'delivered' }).where(and(byId, inArray(outbox.status, ['queued', 'sent'])));
        return;
      case 'delayed':
        await tx.update(outbox).set({ lastError: 'delayed' }).where(and(byId, eq(outbox.status, 'sent')));
        return;
      default:
        await tx
          .update(outbox)
          .set({ status: 'failed', lastError: `${event.status}${event.reason ? `: ${event.reason}` : ''}`.slice(0, 500) })
          // Повторное событие об уже не доставленном письме строку не трогает (итоговая проверка W0, I3).
          .where(and(byId, ne(outbox.status, 'failed')));
    }
  });
}


/**
 * Сообщения сотрудника, письмо о которых не доставлено (решение 21 вехи M4): отметка "Письмо не доставлено" в рабочем
 * месте. Читает сотрудник под своим актором: строки очереди клиенту не видны.
 */
export async function undeliveredMessages(actor: StaffActor, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await withActor(actor, (tx) =>
    tx
      .selectDistinct({ messageId: outbox.messageId })
      .from(outbox)
      .where(and(inArray(outbox.messageId, messageIds.slice(0, 500)), eq(outbox.status, 'failed'), eq(outbox.channel, 'email'))),
  );
  return new Set(rows.map((r) => r.messageId).filter((id): id is string => id !== null));
}

/** Отправленные строки очереди хранятся столько суток: в них текст письма (аудит 23.11.2026, находка P6). */
export const OUTBOX_KEEP_DAYS = 30;

/** Ночная очистка: отправленные, доставленные и пропущенные строки старше срока. Ждущие и не отправленные остаются. */
export async function cleanupOutboxTx(actor: SystemActor, now: Date): Promise<number> {
  const before = new Date(now.getTime() - OUTBOX_KEEP_DAYS * 86_400_000);
  const rows = await withActor(actor, (tx) =>
    tx
      .delete(outbox)
      .where(and(inArray(outbox.status, ['sent', 'delivered', 'skipped']), lt(outbox.createdOn, before)))
      .returning({ outboxId: outbox.outboxId }),
  );
  return rows.length;
}
