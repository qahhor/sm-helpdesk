import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Actor } from '@/db/with-actor';
import { asActor, pools } from '../helpers/db';
import { seedTwoOrgs } from './fixture';

// Второй слой защиты записи (вторая проверка M2, миграция 0018): база сама не даёт клиенту и сотруднику сделать то,
// чего не делает ни одна операция портала. Запросы идут напрямую под ролью hub_app с переменными актора.

const rows = <T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []) =>
  asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rows as T[]);
const run = (actor: Actor, sql: string, params: unknown[] = []) => asActor(pools.app, actor, (c) => c.query(sql, params)).then((r) => r.rowCount);
const SYSTEM = { type: 'system', job: 'test' } as const;

const setStatus = (ticketId: string, status: string, extra = '') =>
  pools.root.query(`update hdt_tickets set status = $2${extra ? `, ${extra}` : ''} where ticket_id = $1`, [ticketId, status]);
const ticketRow = (ticketId: string) =>
  pools.root
    .query(`select status, closed_on, last_client_message_on, csat_score from hdt_tickets where ticket_id = $1`, [ticketId])
    .then((r) => r.rows[0] as { status: string; closed_on: Date | null; last_client_message_on: Date | null; csat_score: number | null });

test('клиент меняет статус только переходами своих операций: подтвердить, открыть заново, ответить (раздел 7.2)', async () => {
  const f = await seedTwoOrgs();
  const id = f.tickets.aOrg.ticketId;
  const set = (change: string) => run(f.aUser.actor, `update hdt_tickets set ${change} where ticket_id = $1`, [id]);
  // Из "Новое" и "В работе" клиент статус не двигает: решает и закрывает сотрудник.
  for (const from of ['new', 'in_progress']) {
    await setStatus(id, from);
    for (const to of ['resolved', 'closed', 'waiting_customer', 'in_progress'].filter((s) => s !== from))
      await expect(set(`status = '${to}'`), `${from} -> ${to}`).rejects.toThrow(/нельзя/);
  }
  // Разрешённые переходы.
  for (const [from, to] of [
    ['waiting_customer', 'in_progress'],
    ['resolved', 'in_progress'],
    ['resolved', 'closed'],
    ['closed', 'in_progress'],
  ]) {
    await setStatus(id, from, `closed_on = case when '${from}' = 'closed' then now() else null end`);
    expect(await set(`status = '${to}'`), `${from} -> ${to}`).toBe(1);
  }
  // Из решённого не в ожидание и не в новое.
  await setStatus(id, 'resolved');
  for (const to of ['new', 'waiting_customer']) await expect(set(`status = '${to}'`), `resolved -> ${to}`).rejects.toThrow(/нельзя/);
});

test('даты закрытия и последнего сообщения клиента ставит база, а не клиент', async () => {
  const f = await seedTwoOrgs();
  const id = f.tickets.aOrg.ticketId;
  const set = (change: string) => run(f.aUser.actor, `update hdt_tickets set ${change} where ticket_id = $1`, [id]);
  // Подтверждение решения: дата закрытия будущим числом не принимается, ставится текущая.
  await setStatus(id, 'resolved');
  expect(await set(`status = 'closed', closed_on = '2100-01-01'`)).toBe(1);
  const closed = await ticketRow(id);
  expect(closed.status).toBe('closed');
  expect(Math.abs((closed.closed_on as Date).getTime() - Date.now())).toBeLessThan(60_000);
  // Отдельно дату закрытия клиент не меняет: иначе срок повторного открытия стал бы бесконечным.
  await expect(set(`closed_on = '2100-01-01'`)).rejects.toThrow(/нельзя/);
  // Последнее сообщение клиента: время базы, а не присланное.
  expect(await set(`last_client_message_on = '2000-01-01'`)).toBe(1);
  const replied = await ticketRow(id);
  expect(Math.abs((replied.last_client_message_on as Date).getTime() - Date.now())).toBeLessThan(60_000);
  // Дату решения клиент не трогает совсем.
  await expect(set(`resolved_on = now()`)).rejects.toThrow(/нельзя/);
});

test('оценка: только автор, только закрытого обращения и только один раз (FR-TK-11)', async () => {
  const f = await seedTwoOrgs();
  const id = f.tickets.aOrg.ticketId;
  const rate = (actor: Actor, change: string) => run(actor, `update hdt_tickets set ${change} where ticket_id = $1`, [id]);
  await setStatus(id, 'resolved');
  await expect(rate(f.aUser.actor, `csat_score = 5`), 'решённое, ещё не закрытое').rejects.toThrow(/нельзя/);
  await setStatus(id, 'closed', 'closed_on = now()');
  await expect(rate(f.aAdmin.actor, `csat_score = 5`), 'администратор за автора').rejects.toThrow(/нельзя/);
  await expect(rate(f.aUser.actor, `csat_comment = 'без оценки'`), 'комментарий без оценки').rejects.toThrow(/нельзя/);
  expect(await rate(f.aUser.actor, `csat_score = 2, csat_reason = 'slow', csat_comment = 'долго'`)).toBe(1);
  for (const change of [`csat_score = 5`, `csat_score = null`, `csat_comment = 'передумал'`, `csat_reason = 'other'`])
    await expect(rate(f.aUser.actor, change), change).rejects.toThrow(/нельзя/);
  expect((await ticketRow(id)).csat_score).toBe(2);
});

test('клиент не создаёт обращение с оценкой или датой последнего сообщения', async () => {
  const f = await seedTwoOrgs();
  for (const [column, value] of [
    ['csat_reason', "'slow'"],
    ['csat_comment', "'x'"],
    ['last_client_message_on', 'now()'],
  ])
    await expect(
      run(
        f.aUser.actor,
        `insert into hdt_tickets (org_id, author_id, type, impact, priority, title, description, locale, source, ${column})
         values ($1, $2, 'bug', 'major', 'p2', 'x', 'x', 'ru', 'portal', ${value})`,
        [f.orgA.orgId, f.aUser.userId],
      ),
      column,
    ).rejects.toThrow(/нельзя/);
});

test('сообщение клиента: только из его каналов и без идентификатора письма', async () => {
  const f = await seedTwoOrgs();
  const insert = (columns: string, values: string) =>
    run(
      f.aUser.actor,
      `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body${columns}) values ($1, $2, $3, 'client', 'x'${values})`,
      [f.orgA.orgId, f.tickets.aOrg.ticketId, f.aUser.userId],
    );
  expect(await insert('', '')).toBe(1);
  expect(await insert(', source', ", 'widget_web'")).toBe(1);
  for (const source of ['email', 'staff', 'telegram']) await expect(insert(', source', `, '${source}'`), source).rejects.toThrow(/row-level security/);
  await expect(insert(', email_message_id', ", '<forged@mail>'")).rejects.toThrow(/row-level security/);
});

test('событие истории клиент пишет только о своих операциях, от своего имени и в видимом обращении', async () => {
  const f = await seedTwoOrgs();
  const insert = (ticketId: string, kind: string, extra: { actorId?: string; internal?: boolean; actorType?: string; orgId?: string } = {}) =>
    run(
      f.aUser.actor,
      `insert into hdt_ticket_events (org_id, ticket_id, kind, actor_type, actor_id, payload, is_internal) values ($1, $2, $3, $4, $5, '{}', $6)`,
      [extra.orgId ?? f.orgA.orgId, ticketId, kind, extra.actorType ?? 'client', extra.actorId ?? f.aUser.userId, extra.internal ?? false],
    );
  expect(await insert(f.tickets.aOrg.ticketId, 'status')).toBe(1);
  for (const kind of ['priority', 'assignee', 'queue', 'due', 'rule', 'merge'])
    await expect(insert(f.tickets.aOrg.ticketId, kind), kind).rejects.toThrow(/row-level security/);
  await expect(insert(f.tickets.aOrg.ticketId, 'status', { internal: true }), 'внутреннее').rejects.toThrow(/row-level security/);
  await expect(insert(f.tickets.aOrg.ticketId, 'status', { actorId: f.aAdmin.userId }), 'от имени коллеги').rejects.toThrow(/row-level security/);
  await expect(insert(f.tickets.aOrg.ticketId, 'status', { actorType: 'staff' }), 'от имени сотрудника').rejects.toThrow(/row-level security/);
  await expect(insert(f.tickets.aPrivate.ticketId, 'status'), 'личное обращение коллеги').rejects.toThrow(/row-level security/);
  await expect(insert(f.tickets.bOrg.ticketId, 'status', { orgId: f.orgB.orgId }), 'обращение Б').rejects.toThrow(/row-level security/);
});

test('своё обращение организации А не видно, пока активна организация Б (ТЗ 15.2)', async () => {
  const f = await seedTwoOrgs();
  const inB = { ...f.aUser.actor, orgId: f.orgB.orgId };
  // Пользователь А вошёл в организацию Б: своих обращений из А он там не видит, ни по номеру, ни списком.
  expect(await rows(inB, 'select 1 from hdt_tickets where author_id = $1', [f.aUser.userId])).toEqual([]);
  expect(await rows(inB, 'select 1 from hdt_tickets where number = $1', [f.tickets.aMine.number])).toEqual([]);
  for (const table of ['hdt_ticket_messages', 'hdt_ticket_events', 'hdt_attachments'])
    expect(await rows(inB, `select 1 from ${table} where ticket_id = $1`, [f.tickets.aOrg.ticketId]), table).toEqual([]);
});

test('заражённый и отклонённый файл коллеги не виден, свой загрузивший видит', async () => {
  const f = await seedTwoOrgs();
  for (const status of ['infected', 'rejected'])
    await pools.root.query(
      `insert into hdt_attachments (org_id, ticket_id, uploader_id, storage_key, file_name, mime, size, scan_status)
       values ($1, $2, $3, $4, $5, 'image/png', 10, $6)`,
      [f.orgA.orgId, f.tickets.aOrg.ticketId, f.aAdmin.userId, `files/x/${randomUUID()}`, `${status}.png`, status],
    );
  const names = (actor: Actor) =>
    rows<{ file_name: string }>(actor, `select file_name from hdt_attachments where scan_status in ('infected', 'rejected') order by file_name`).then((r) =>
      r.map((x) => x.file_name),
    );
  expect(await names(f.aUser.actor)).toEqual([]);
  expect(await names(f.aAdmin.actor)).toEqual(['infected.png', 'rejected.png']);
});

test('вложение: новая загрузка лежит в карантине под своим ключом и без результатов проверки', async () => {
  const f = await seedTwoOrgs();
  const insert = (actor: Actor, id: string, key: string, extra: { column: string; value: string } | null = null) =>
    run(
      actor,
      `insert into hdt_attachments (attachment_id, org_id, uploader_id, storage_key, file_name, mime, size, scan_status${extra ? `, ${extra.column}` : ''})
       values ($1, $2, $3, $4, 'a.png', 'image/png', 10, 'pending'${extra ? `, ${extra.value}` : ''})`,
      [id, f.orgA.orgId, actor.type === 'client' ? f.aUser.userId : f.l1.userId, key],
    );
  const ok = randomUUID();
  expect(await insert(f.aUser.actor, ok, `quarantine/${ok}`)).toBe(1);
  // Ключ чужой загрузки или проверенного файла: файл подменил бы другой.
  const other = randomUUID();
  for (const key of [`quarantine/${randomUUID()}`, `files/${f.orgA.orgId}/${other}`, `quarantine/${other}/x`])
    await expect(insert(f.aUser.actor, other, key), key).rejects.toThrow(/нельзя/);
  for (const [column, value] of [
    ['sha256', `'${'a'.repeat(64)}'`],
    ['detected_type', "'png'"],
    ['scan_signature', "'clean'"],
  ]) {
    // Ключ верный: отказ только из-за поля проверки.
    const id = randomUUID();
    await expect(insert(f.aUser.actor, id, `quarantine/${id}`, { column, value }), column).rejects.toThrow(/нельзя/);
  }
  // Сотрудник тоже загружает только в карантин и без результатов проверки.
  const staffId = randomUUID();
  await expect(insert(f.l1.actor, staffId, `files/${f.orgA.orgId}/${staffId}`)).rejects.toThrow(/нельзя/);
  await expect(
    run(
      f.l1.actor,
      `insert into hdt_attachments (attachment_id, org_id, uploader_id, storage_key, file_name, mime, size, scan_status)
       values ($1, $2, $3, $4, 'a.png', 'image/png', 10, 'clean')`,
      [staffId, f.orgA.orgId, f.l1.userId, `quarantine/${staffId}`],
    ),
  ).rejects.toThrow(/нельзя/);
});

test('результат проверки и ключ хранилища меняет только система, сотрудник тоже нет', async () => {
  const f = await seedTwoOrgs();
  const id = randomUUID();
  await pools.root.query(
    `insert into hdt_attachments (attachment_id, org_id, uploader_id, storage_key, file_name, mime, size) values ($1, $2, $3, $4, 'a.png', 'image/png', 10)`,
    [id, f.orgA.orgId, f.aUser.userId, `quarantine/${id}`],
  );
  const set = (actor: Actor, change: string) => run(actor, `update hdt_attachments set ${change} where attachment_id = $1`, [id]);
  for (const change of [
    `scan_status = 'clean'`,
    `scan_signature = 'x'`,
    `detected_type = 'png'`,
    `sha256 = '${'b'.repeat(64)}'`,
    `storage_key = 'files/${f.orgA.orgId}/${id}'`,
  ])
    await expect(set(f.l1.actor, change), change).rejects.toThrow(/нельзя/);
  expect(await set(SYSTEM, `scan_status = 'clean', storage_key = 'files/${f.orgA.orgId}/${id}', detected_type = 'png', sha256 = '${'b'.repeat(64)}'`)).toBe(1);
});

test('загрузку клиент прикрепляет к своему сообщению или к описанию своего обращения, не к чужим', async () => {
  const f = await seedTwoOrgs();
  const ticket = f.tickets.aOrg; // автор aUser, видимость "организация"
  const upload = async (uploader: { userId: string }) => {
    const id = randomUUID();
    await pools.root.query(
      `insert into hdt_attachments (attachment_id, org_id, uploader_id, storage_key, file_name, mime, size) values ($1, $2, $3, $4, 'a.png', 'image/png', 10)`,
      [id, f.orgA.orgId, uploader.userId, `quarantine/${id}`],
    );
    return id;
  };
  const message = (authorId: string) =>
    pools.root
      .query(
        `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body) values ($1, $2, $3, 'client', 'ответ') returning message_id`,
        [f.orgA.orgId, ticket.ticketId, authorId],
      )
      .then((r) => r.rows[0].message_id as string);
  const attach = (actor: Actor, id: string, messageId: string | null) =>
    run(actor, `update hdt_attachments set ticket_id = $2, message_id = $3 where attachment_id = $1`, [id, ticket.ticketId, messageId]);
  const adminMessage = await message(f.aAdmin.userId);
  const userMessage = await message(f.aUser.userId);
  // Администратор отвечает в обращении коллеги: к своему сообщению можно, к сообщению автора и к описанию нельзя.
  await expect(attach(f.aAdmin.actor, await upload(f.aAdmin), userMessage), 'к чужому сообщению').rejects.toThrow(/row-level security/);
  await expect(attach(f.aAdmin.actor, await upload(f.aAdmin), null), 'к описанию чужого обращения').rejects.toThrow(/row-level security/);
  expect(await attach(f.aAdmin.actor, await upload(f.aAdmin), adminMessage)).toBe(1);
  // Автор прикрепляет к описанию своего обращения и к своему сообщению.
  expect(await attach(f.aUser.actor, await upload(f.aUser), null)).toBe(1);
  expect(await attach(f.aUser.actor, await upload(f.aUser), userMessage)).toBe(1);
});
