import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import { getTicket, handleAttachmentRequest } from '@/modules/hdt/api';
import { handleEmbedTicket, handleEmbedTickets } from '@/modules/hdt/api/embed';
import { signEmbedToken } from '@/modules/hdu/core/embed-token';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// "Мои обращения" в виджете (план M6, задача 6; FR-WG-06, строка 15.2 ТЗ; решение 13). Те же клиентские проекции и
// политики RLS, что у страниц портала. Раздел "На что смотреть", пункты 4 и 8: токен виджета пользователя А с номером
// обращения Б даёт "Не найдено"; внутренние заметки, сотрудники, внутренние файлы и события в ответы не попадают.

const HUB = process.env.HUB_URL as string;
const SECRET = process.env.EMBED_TOKEN_SECRET as string;
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  // Виджет у сервера набора включён: без режима ключей токены виджета не действуют (проверка M6, M3).
  await pools.root.query(`update hdu_servers set context_key_mode = 'jwks', context_jwks_url = 'https://keys.smartup.example/jwks' where server_id = $1`, [f.server.serverId]);
  setStorageForTests(new MemoryStorage());
  setJobQueueForTests(new MemoryJobQueue());
});
afterEach(() => {
  setStorageForTests(null);
  setJobQueueForTests(null);
});

const tokenFor = (member: { userId: string }, orgId: string) =>
  signEmbedToken({ userId: member.userId, orgId, serverId: f.server.serverId, platform: 'web' }, { secret: SECRET, issuer: HUB });

function call(path: string, token: string | undefined, body?: unknown): Request {
  return new Request(`${HUB}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const view = (token: string | undefined, number: number | string) => handleEmbedTicket(call(`/api/embed/tickets/${number}`, token), String(number));

test('токен виджета пользователя А с номером обращения Б: "Не найдено", как чужое личное и несуществующее', async () => {
  const a = await tokenFor(f.aUser, f.orgA.orgId);
  const answers = [];
  for (const number of [f.tickets.bOrg.number, `SUP-${f.tickets.bOrg.number}`, f.tickets.bPrivate.number, f.tickets.aPrivate.number, 999_999]) {
    const response = await view(a, number);
    answers.push([response.status, await response.json()]);
  }
  // Неразличимы: тот же ответ для чужой организации, чужого личного и несуществующего.
  expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
  expect(answers[0]).toEqual([404, expect.objectContaining({ code: 'not_found' })]);
  // Действие с чужим обращением тоже "не найдено" и ничего не меняет.
  const reply = await handleEmbedTicket(call(`/api/embed/tickets/${f.tickets.bOrg.number}`, a, { action: 'reply', body: 'чужое' }), String(f.tickets.bOrg.number));
  expect(reply.status).toBe(404);
  expect((await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where body = 'чужое'`)).rows[0].n).toBe(0);
});

test('список: только мои обращения в организации из токена', async () => {
  const a = await tokenFor(f.aUser, f.orgA.orgId);
  const response = await handleEmbedTickets(call('/api/embed/tickets', a));
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  const body = (await response.json()) as { items: { number: number }[]; nextCursor: string | null };
  expect(body.items.map((i) => i.number).sort()).toEqual([f.tickets.aOrg.number, f.tickets.aMine.number].sort());
  expect((await handleEmbedTickets(call('/api/embed/tickets', undefined))).status).toBe(401);
});

test('страница обращения: только клиентская проекция без внутренних заметок, сотрудников, файлов и событий', async () => {
  const a = await tokenFor(f.aUser, f.orgA.orgId);
  const response = await view(a, f.tickets.aOrg.number);
  expect(response.status).toBe(200);
  const text = await response.text();
  const body = JSON.parse(text) as { messages: { body: string; authorName: string | null }[]; attachments: unknown[] };
  expect(body.messages.map((m) => m.body)).toEqual(['Публичное сообщение']);
  for (const hidden of ['Внутренняя заметка', f.l1.name, f.l1.userId, 'is_internal', 'isInternal', 'tags', 'signature', 'assignee', 'queue', 'priority', 'events'])
    expect(text, hidden).not.toContain(hidden);
  // Внутреннее вложение сотрудника не видно, как и непроверенный файл коллеги: тот же набор, что на портале.
  const internal = (await pools.root.query(`select attachment_id from hdt_attachments where ticket_id = $1 and is_internal`, [f.tickets.aOrg.ticketId])).rows[0].attachment_id;
  const portal = (await getTicket(await clientCtx(f.aUser), String(f.tickets.aOrg.number)))!;
  expect((body.attachments as { attachmentId: string }[]).map((x) => x.attachmentId)).toEqual(portal.attachments.map((x) => x.attachmentId));
  expect(text).not.toContain(internal);
});

test('ответ и подтверждение решения общими операциями; файл по токену только чистый и своего обращения', async () => {
  const a = await tokenFor(f.aUser, f.orgA.orgId);
  const number = f.tickets.aOrg.number;
  const replied = await handleEmbedTicket(call(`/api/embed/tickets/${number}`, a, { action: 'reply', body: 'Ответ из виджета' }), String(number));
  expect(replied.status).toBe(200);
  expect(((await replied.json()) as { messages: { body: string; isMine: boolean }[] }).messages.at(-1)).toMatchObject({ body: 'Ответ из виджета', isMine: true });

  await pools.root.query(`update hdt_tickets set status = 'resolved', resolved_on = now() where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  const page = (await (await view(a, number)).json()) as { can: { confirm: boolean } };
  expect(page.can.confirm).toBe(true);
  const confirmed = await handleEmbedTicket(call(`/api/embed/tickets/${number}`, a, { action: 'confirm' }), String(number));
  expect(((await confirmed.json()) as { status: string }).status).toBe('closed');
  expect((await pools.root.query(`select count(*)::int as n from hdc_audit_log where object_id = $1 and action like 'ticket.%'`, [f.tickets.aOrg.ticketId])).rows[0].n).toBeGreaterThan(0);

  for (const bad of [{ action: 'reopen' }, { action: 'reply' }, { action: 'confirm', orgId: f.orgB.orgId }])
    expect((await handleEmbedTicket(call(`/api/embed/tickets/${number}`, a, bad), String(number))).status, JSON.stringify(bad)).toBe(400);

  const clean = (await pools.root.query(`select attachment_id from hdt_attachments where ticket_id = $1 and scan_status = 'clean' and not is_internal`, [f.tickets.aOrg.ticketId])).rows[0].attachment_id;
  const other = (await pools.root.query(`select attachment_id from hdt_attachments where ticket_id = $1`, [f.tickets.bOrg.ticketId])).rows[0].attachment_id;
  const internal = (await pools.root.query(`select attachment_id from hdt_attachments where ticket_id = $1 and is_internal`, [f.tickets.aOrg.ticketId])).rows[0].attachment_id;
  const download = await handleAttachmentRequest(call(`/api/attachments/${clean}`, a), clean);
  expect(download.status).toBe(200);
  expect(((await download.json()) as { url: string }).url).toMatch(/^https?:\/\//);
  for (const id of [other, internal]) expect((await handleAttachmentRequest(call(`/api/attachments/${id}`, a), id)).status).toBe(404);
  expect((await handleAttachmentRequest(call(`/api/attachments/${clean}`, 'bad.token.value'), clean)).status).toBe(401);
});
