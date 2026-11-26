import { beforeEach, expect, test } from 'vitest';
import { setLogSinkForTests } from '@/lib/log';
import { markBackup, noteStaffSignInFailure } from '@/modules/hdc/api';
import { createMemoryEmailProvider, type MemoryEmailProvider } from '@/modules/hdn/testing';
import { opsAlertText } from '@/modules/hdn/api/ops';
import { collectOpsAlerts, opsWatch } from '@/worker/ops-watch';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Сигналы дежурным (аудит 23.11.2026, находки O2 и S4; ТЗ 13.8): упавшие задачи, очередь исходящих, письма без
// разбора, подбор пароля сотрудника, заражённые файлы. Письмом и в чат дежурных, не чаще раза в час на вид,
// только числа: без адресов, имён и текстов.

const SYSTEM = { type: 'system', job: 'ops.watch' } as const;
let f: Fixture;
let mail: MemoryEmailProvider;
let chat: string[];
beforeEach(async () => {
  f = await seedTwoOrgs();
  mail = createMemoryEmailProvider();
  chat = [];
  await pools.root.query(`delete from hdn_outbox`);
  await pools.root.query(`delete from hdn_email_inbound`);
  await pools.root.query(`delete from pgboss.job where state = 'failed'`);
  await pools.root.query(`update hdt_attachments set scan_status = 'clean' where scan_status = 'infected'`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('notify.oncall_emails', '["duty@smartup24.com"]')`);
  // Свежая ночная копия: без неё каждый запуск давал бы сигнал backup_stale (план подготовки M9, задача 3; его
  // проверяет ops-watch-backup.test.ts).
  await pools.root.query(`delete from hdc_ops_backups`);
  await markBackup(SYSTEM, { kind: 'dump' }, new Date());
});

const watch = (now = new Date()) => opsWatch(SYSTEM, now, { provider: mail, oncall: { send: async (text) => void chat.push(text) } });
const failedOutbox = (n: number) =>
  pools.root.query(
    `insert into hdn_outbox (ticket_id, channel, recipient_kind, recipient_user_id, template, payload, status, attempts)
     select $1, 'email', 'user', $2, 'ticket_resolved', $3, 'failed', 6 from generate_series(1, $4)`,
    [f.tickets.aOrg.ticketId, f.aUser.userId, JSON.stringify({ template: 'ticket_resolved', number: 1, title: 'x', url: '/tickets' }), n],
  );

test('всё в порядке: сигналов нет', async () => {
  expect(await watch()).toEqual([]);
  expect(chat).toEqual([]);
  expect(mail.sent).toEqual([]);
});

test('не отправленные сообщения очереди: сигнал в чат и письмом дежурным, только число', async () => {
  await failedOutbox(3);
  expect(await watch()).toEqual(['outbox_failed']);
  expect(chat).toHaveLength(1);
  expect(chat[0]).toContain('3');
  expect(mail.sent.map((s) => s.message.to)).toEqual(['duty@smartup24.com']);
  expect(mail.sent[0]!.message.text).toContain('3');
  expect(mail.sent[0]!.message.subject).toContain('Smartup Hub');
});

test('один вид сигнала не чаще раза в час', async () => {
  await failedOutbox(1);
  const now = Date.now();
  expect(await watch(new Date(now))).toEqual(['outbox_failed']);
  expect(await watch(new Date(now + 10 * 60_000))).toEqual([]);
  expect(chat).toHaveLength(1);
  // Час прошёл: отметка последнего сигнала отодвигается назад, новый сбой даёт новый сигнал.
  await pools.root.query(`update hdc_ops_alerts set last_sent_on = now() - interval '61 minutes'`);
  expect(await watch(new Date(now))).toEqual(['outbox_failed']);
  expect(chat).toHaveLength(2);
});

test('очередь стоит дольше 5 минут', async () => {
  await pools.root.query(
    `insert into hdn_outbox (ticket_id, channel, recipient_kind, recipient_user_id, template, payload, next_attempt_on)
     values ($1, 'email', 'user', $2, 'ticket_resolved', $3, now() - interval '9 minutes')`,
    [f.tickets.aOrg.ticketId, f.aUser.userId, JSON.stringify({ template: 'ticket_resolved', number: 1, title: 'x', url: '/tickets' })],
  );
  expect(await watch()).toEqual(['outbox_lag']);
  expect(chat[0]).toMatch(/9|8/);
});

test('письма без разбора дольше 10 минут', async () => {
  await pools.root.query(
    `insert into hdn_email_inbound (provider_id, from_address, subject, message_id, raw_ref, received_on)
     values ('stuck-1', 'x@example.uz', 'Тема', '<stuck-1@example.uz>', 'stuck-1', now())`,
  );
  // Триггер служебных колонок обходится только внутри транзакции: соединение пула не остаётся без триггеров.
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query(`set local session_replication_role = replica`);
    await client.query(`update hdn_email_inbound set created_on = now() - interval '20 minutes'`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  expect(await watch()).toEqual(['inbound_stuck']);
});

test('20 неудачных входов сотрудников за 15 минут: сигнал только с числом', async () => {
  await pools.root.query(`delete from hdc_rate_limits`);
  for (let i = 0; i < 19; i++) await noteStaffSignInFailure();
  expect(await watch()).toEqual([]);
  await noteStaffSignInFailure();
  expect(await watch()).toEqual(['staff_signin_failures']);
  expect(chat[0]).toContain('20');
  // Окно 15 минут прошло: счётчик больше не считается.
  await pools.root.query(`update hdc_ops_alerts set last_sent_on = now() - interval '2 hours'`);
  expect(await watch(new Date(Date.now() + 16 * 60_000))).toEqual([]);
});

test('заражённый файл за последний час', async () => {
  await pools.root.query(
    `update hdt_attachments set scan_status = 'infected', scan_signature = 'Eicar-Test', scanned_on = now() where attachment_id = (select attachment_id from hdt_attachments limit 1)`,
  );
  expect(await watch()).toEqual(['infected_files']);
  expect(chat[0]).not.toContain('Eicar');
});

test('упавшие фоновые задачи за час', async () => {
  await pools.root.query(`insert into pgboss.job (name, state, completed_on) values ('email.inbound', 'failed', now())`);
  expect(await watch()).toEqual(['jobs_failed']);
});

test('сбой чата не мешает письму, и наоборот; сигнал считается отправленным', async () => {
  await failedOutbox(1);
  const codes = await opsWatch(SYSTEM, new Date(), {
    provider: mail,
    oncall: {
      send: async () => {
        throw new Error('Telegram не ответил');
      },
    },
  });
  expect(codes).toEqual(['outbox_failed']);
  expect(mail.sent).toHaveLength(1);
});

test('недоставка у получателя (отказ почтового сервера) дежурных не будит: это видно на обращении (итоговая проверка W0, I3)', async () => {
  // Письмо ушло (sent_on задан), затем почтовый сервис сообщил об отказе: строка failed, но это не сбой портала.
  await pools.root.query(
    `insert into hdn_outbox (ticket_id, channel, recipient_kind, recipient_user_id, template, payload, status, attempts, sent_on, last_error)
     values ($1, 'email', 'user', $2, 'ticket_resolved', $3, 'failed', 1, now(), 'bounced: mailbox does not exist')`,
    [f.tickets.aOrg.ticketId, f.aUser.userId, JSON.stringify({ template: 'ticket_resolved', number: 1, title: 'x', url: '/tickets' })],
  );
  expect(await watch()).toEqual([]);
});

test('дежурные не настроены: сигнал не считается отправленным, в журнале ошибка (итоговая проверка W0, I4)', async () => {
  await pools.root.query(`delete from hdc_settings where code = 'notify.oncall_emails'`);
  await failedOutbox(2);
  const events: [string, string][] = [];
  setLogSinkForTests((level, event) => events.push([level, event]));
  try {
    expect(await opsWatch(SYSTEM, new Date(), { provider: mail, oncall: null })).toEqual([]);
  } finally {
    setLogSinkForTests(null);
  }
  expect(events).toContainEqual(['error', 'ops.alert_undelivered']);
});

// Сбой архива журнала базы (аудит 23.11.2026, находка O5; план W2, задача 11): непрерывный архив молча
// перестаёт работать, когда команда архива падает (диск полон, каталог недоступен). Узнать об этом в день аварии
// поздно, поэтому состояние архива проверяет ops.watch.

test('сбой архива журнала: сигнал только когда архив включён и последняя попытка неудачна', async () => {
  const { archiveFailing } = await import('@/modules/hdc/api');
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  expect(archiveFailing({ mode: 'off', failedCount: 5, lastFailedOn: at(1), lastArchivedOn: null })).toBe(false);
  expect(archiveFailing({ mode: 'on', failedCount: 0, lastFailedOn: null, lastArchivedOn: at(3) })).toBe(false);
  // Сбой был, но после него сегменты снова уходят: архив работает.
  expect(archiveFailing({ mode: 'on', failedCount: 4, lastFailedOn: at(30), lastArchivedOn: at(2) })).toBe(false);
  expect(archiveFailing({ mode: 'on', failedCount: 4, lastFailedOn: at(1), lastArchivedOn: at(30) })).toBe(true);
  // Ни один сегмент ещё не ушёл, а попытки падают.
  expect(archiveFailing({ mode: 'always', failedCount: 2, lastFailedOn: at(1), lastArchivedOn: null })).toBe(true);
});

test('состояние архива читается под ролью приложения; при выключенном архиве сигнала нет', async () => {
  const { archiveState } = await import('@/modules/hdc/api');
  const state = await archiveState(SYSTEM);
  expect(state.mode).toBe('off');
  expect(state.failedCount).toBe(0);
  expect((await collectOpsAlerts(SYSTEM, new Date())).map((alert) => alert.code)).not.toContain('archive_failing');
  expect(opsAlertText({ code: 'archive_failing', count: 3 })).toContain('3');
});

// --- Общий предел на письма с неизвестных адресов (план W2, задача 13; M4, мелкое 9) ---

test('придержанные письма: за час сработал предел частоты на 10 и больше писем, дежурные получают число', async () => {
  const held = (n: number, tag: string) =>
    pools.root.query(
      `insert into hdn_email_inbound (provider_id, from_address, subject, message_id, raw_ref, received_on, processed_on, classification)
       select $2 || g, 'x' || g || '@example.uz', 'Тема', '<' || $2 || g || '@example.uz>', $2 || g, now(), now(), 'rate_limited' from generate_series(1, $1::int) g`,
      [n, tag],
    );
  // Один шумный отправитель дежурных не будит.
  await held(9, 'few-');
  expect(await watch()).toEqual([]);
  await held(1, 'more-');
  expect(await watch()).toEqual(['inbound_held']);
  expect(chat).toEqual([opsAlertText({ code: 'inbound_held', count: 10 })]);
  expect(chat[0]).toContain('10');
  // В сигнале только число: без адресов и тем.
  expect(chat[0]).not.toContain('example.uz');
});

test('поток обращений с неизвестных адресов: 60 и больше за час, дежурные получают число (проверка волны 2)', async () => {
  const flood = (n: number) =>
    pools.root.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, status, queue)
       select app.service_org_id(), $1, 'question', 'minor', 'p3', 'private', 'Письмо ' || g, 'Текст', 'ru', 'email', 'new', 'l1' from generate_series(1, $2::int) g`,
      [f.aUser.userId, n],
    );
  // Служебная организация "Неопознанные" заводится первым письмом с неизвестного адреса; здесь строкой.
  await pools.root.query(`insert into hdu_organizations (org_id, name, kind) values (app.service_org_id(), 'Неопознанные', 'service') on conflict do nothing`);
  await flood(59);
  expect(await watch()).toEqual([]);
  await flood(1);
  expect(await watch()).toEqual(['unidentified_flood']);
  expect(chat).toEqual([opsAlertText({ code: 'unidentified_flood', count: 60 })]);
});

test('заражённый файл гостя перешёл к пользователю: сигнал о нём не повторяется (проверка волны 0, мелкое 2)', async () => {
  // Файл найден заражённым два часа назад: сигнал о нём уже был. Сейчас строка изменилась (сменился владелец).
  await pools.root.query(
    `update hdt_attachments set scan_status = 'infected', scan_signature = 'Eicar-Test', scanned_on = now() - interval '2 hours'
      where attachment_id = (select attachment_id from hdt_attachments limit 1)`,
  );
  await pools.root.query(`update hdt_attachments set file_name = file_name where scan_status = 'infected'`);
  expect((await pools.root.query(`select count(*)::int as n from hdt_attachments where scan_status = 'infected' and modified_on > now() - interval '1 minute'`)).rows[0].n).toBe(1);
  expect(await watch()).toEqual([]);
});

test('смена токена бота дежурных оставляет запись в журнале в той же транзакции, что и сам токен (M4, мелкое 12)', async () => {
  const { saveOncall } = await import('@/modules/hdn/api/mail-settings');
  const { staffCtx } = await import('./helpers/auth');
  await pools.root.query(`delete from hdc_settings where code = 'notify.oncall_emails'`);
  await saveOncall(staffCtx(f.adminStaff), { emails: ['duty@smartup24.com'], chatId: '-100123', bot: 'own', botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0' });
  const rows = (await pools.root.query(`select actor_type, diff, txid_current() is not null as ok from hdc_audit_log where action = 'settings.oncall_bot_replaced'`)).rows;
  expect(rows).toEqual([{ actor_type: 'system', diff: { by: f.adminStaff.userId }, ok: true }]);
  // Запись и секрет зафиксированы одной транзакцией: номера транзакций строк совпадают.
  const same = (
    await pools.root.query(
      `select (select xmin::text from hdc_audit_log where action = 'settings.oncall_bot_replaced') = (select xmin::text from hdn_channel_secrets limit 1) as same`,
    )
  ).rows[0].same;
  expect(same).toBe(true);
});

test('событие автоматизации снято после пяти сбоев разбора: дежурным сигнал "событие не разобрано", только число', async () => {
  // Событие создания P1, разбор которого упал пять раз: сообщение дежурным о P1 по нему не ушло (план M8, задача 10).
  const { processEvents, emitEventTx, EVENT_MAX_ATTEMPTS } = await import('@/modules/hdc/api');
  const { withActor } = await import('@/db/with-actor');
  const automation = { type: 'system', job: 'automation.process' } as const;
  await withActor(automation, (tx) => emitEventTx(tx, { orgId: f.orgA.orgId, ticketId: f.tickets.aOrg.ticketId, kind: 'ticket_created', payload: { priority: 'p1' } }));
  const failing = async () => {
    throw new Error('база недоступна: секретный текст');
  };
  // Четыре сбоя: событие ещё в очереди, сигнала нет.
  // Часы разбора подменены: между попытками проходит пауза перед повтором, самая длинная 15 минут.
  const started = Date.now();
  const attemptAt = (n: number) => processEvents(automation, failing, { clock: () => started + (n - 1) * 16 * 60_000 });
  for (let attempt = 1; attempt < EVENT_MAX_ATTEMPTS; attempt++) expect(await attemptAt(attempt)).toEqual({ processed: 0, failed: 1 });
  expect(await watch()).toEqual([]);
  expect(await attemptAt(EVENT_MAX_ATTEMPTS)).toEqual({ processed: 0, failed: 1 });
  expect((await collectOpsAlerts(SYSTEM, new Date())).filter((alert) => alert.code === 'automation_dropped')).toEqual([{ code: 'automation_dropped', count: 1 }]);
  expect(await watch()).toEqual(['automation_dropped']);
  expect(chat).toHaveLength(1);
  expect(chat[0]).toBe(opsAlertText({ code: 'automation_dropped', count: 1 }));
  expect(chat[0]).toContain('1');
  expect(chat[0]).not.toContain('секретный');
  expect(mail.sent.map((s) => s.message.to)).toEqual(['duty@smartup24.com']);
  // Успешно разобранное событие сигнала не даёт; снятое больше часа назад тоже.
  await pools.root.query(`update hdc_ops_alerts set last_sent_on = now() - interval '2 hours'`);
  expect(await watch(new Date(Date.now() + 61 * 60_000))).toEqual([]);
});

// --- Проверка вехи M8, находка I7: встроенные уведомления выключены или очередь событий стоит ---

test('встроенное уведомление выключено, негодно или осталось без своего действия: один сигнал с кодами правил, не чаще раза в час', async () => {
  const { seedBuiltinRules } = await import('./helpers/automation');
  await seedBuiltinRules();
  // Все три правила на месте и включены: сигнала нет.
  expect((await collectOpsAlerts(SYSTEM, new Date())).filter((alert) => alert.code === 'builtin_rule_inactive')).toEqual([]);
  // Одно выключено, у второго условия не проходят схему, у третьего убрано его уведомление.
  await pools.root.query(`update hdw_rules set is_enabled = false where pcode = 'p1_oncall'`);
  await pools.root.query(`update hdw_rules set conditions = '{"match": "all", "items": [{"field": "нет такого поля"}]}' where pcode = 'sla_breach_lead'`);
  await pools.root.query(`update hdw_rules set actions = '[{"action": "add_note", "text": "Оценка"}]' where pcode = 'csat_low_manager'`);
  expect((await collectOpsAlerts(SYSTEM, new Date())).filter((alert) => alert.code === 'builtin_rule_inactive')).toEqual([
    { code: 'builtin_rule_inactive', count: 3, rules: 'p1_oncall, sla_breach_lead, csat_low_manager' },
  ]);
  const now = Date.now();
  expect(await watch(new Date(now))).toEqual(['builtin_rule_inactive']);
  expect(chat).toEqual([opsAlertText({ code: 'builtin_rule_inactive', count: 3, rules: 'p1_oncall, sla_breach_lead, csat_low_manager' })]);
  expect(chat[0]).toContain('p1_oncall, sla_breach_lead, csat_low_manager');
  expect(mail.sent.map((s) => s.message.to)).toEqual(['duty@smartup24.com']);
  // Через 10 минут повтора нет, через час сигнал повторяется: правило всё ещё выключено.
  expect(await watch(new Date(now + 10 * 60_000))).toEqual([]);
  expect(await watch(new Date(now + 61 * 60_000))).toEqual(['builtin_rule_inactive']);
  // Правила вернули: сигнала больше нет.
  await pools.root.query(`delete from hdw_rules`);
  await seedBuiltinRules();
  expect(await watch(new Date(now + 3 * 60 * 60_000))).toEqual([]);
});

test('очередь событий автоматизации стоит: самое старое событие ждёт разбора дольше 5 минут', async () => {
  const event = (minutesAgo: number) =>
    pools.root.query(`insert into hdc_domain_events (org_id, ticket_id, kind, created_on) values ($1, $2, 'client_replied', now() - make_interval(mins => $3))`, [f.orgA.orgId, f.tickets.aOrg.ticketId, minutesAgo]);
  // Событие ждёт четыре минуты: рано.
  await event(4);
  expect(await watch()).toEqual([]);
  await event(12);
  await event(1);
  expect((await collectOpsAlerts(SYSTEM, new Date())).filter((alert) => alert.code === 'automation_lag')).toEqual([{ code: 'automation_lag', count: 3, minutes: 12 }]);
  expect(await watch()).toEqual(['automation_lag']);
  expect(chat).toEqual([opsAlertText({ code: 'automation_lag', count: 3, minutes: 12 })]);
  expect(chat[0]).toContain('12');
  // Очередь разобрана: сигнала нет.
  await pools.root.query(`update hdc_domain_events set processed_on = now()`);
  await pools.root.query(`update hdc_ops_alerts set last_sent_on = now() - interval '2 hours'`);
  expect(await watch()).toEqual([]);
});
