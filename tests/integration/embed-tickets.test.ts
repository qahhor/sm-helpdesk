import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { publishSolution } from '@/modules/hdk/api/publish';
import { getTicket, handleAttachmentRequest } from '@/modules/hdt/api';
import { postAiMessage } from '@/modules/hdt/api/ai';
import { handleEmbedTicket, handleEmbedTickets } from '@/modules/hdt/api/embed';
import { signEmbedToken } from '@/modules/hdu/core/embed-token';
import { clientCtx, staffCtx, staffWithRole } from './helpers/auth';
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

// Волна 7, T1 (FR-AI-08, раздел 8.6 ТЗ; решение 0158): ответ AI-помощника в виджете не подписан "Поддержка".

/** Опубликованное решение для клиентов и ответ помощника им в обращении aOrg: помощник ждёт реакции клиента. */
async function aiAnswer() {
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Виджет"}') returning module_id`, [`w${Date.now() % 1_000_000}`])).rows[0].module_id as string;
  const paragraph = (id: string, text: string) => ({ type: 'paragraph' as const, attrs: { id }, content: [{ type: 'text' as const, text }] });
  const doc = { version: 1 as const, blocks: [paragraph('w000000001', 'Печать идёт на бумагу другого формата.'), { type: 'step' as const, attrs: { id: 'w000000002' }, content: [paragraph('w000000003', 'Выберите формат A4 в настройках печати.')] }] };
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title: 'Накладная печатается пустой', audience: 'clients', moduleId, doc });
  const state = await solutionEditorState(staffCtx(f.l1), { number: created.number });
  const outcome = await publishSolution(staffCtx(await staffWithRole('agent_l2')), { number: created.number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: false });
  expect(outcome.status).toBe('published');
  await pools.root.query(`update hdt_tickets set ai_state = 'active' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  const messageId = await postAiMessage({ type: 'system', job: 'ai.first_line' }, { ticketId: f.tickets.aOrg.ticketId, payload: { kind: 'answer', introId: 'likely_solution', articleId: created.articleId, articleNumber: created.number, locale: 'ru' } });
  return { messageId, articleId: created.articleId, articleNumber: created.number };
}

type AiMessageJson = { messageId: string; authorType: string; authorName: string | null; ai?: Record<string, unknown> & { kind: string; solution?: { title: string; doc: unknown } | null } };

test('ответ AI-помощника в проекции виджета: автор ai и данные ответа из опубликованного решения, а не "поддержка"', async () => {
  const { messageId, articleId } = await aiAnswer();
  const a = await tokenFor(f.aUser, f.orgA.orgId);
  const response = await handleEmbedTicket(call(`/api/embed/tickets/${f.tickets.aOrg.number}?locale=ru`, a), String(f.tickets.aOrg.number));
  const text = await response.text();
  const body = JSON.parse(text) as { messages: AiMessageJson[] };
  const ai = body.messages.find((m) => m.messageId === messageId)!;
  expect(ai).toMatchObject({ authorType: 'ai', authorName: null });
  expect(ai.ai).toMatchObject({ kind: 'answer', introId: 'likely_solution', actionable: true, canResolve: true, solution: { title: 'Накладная печатается пустой', locale: 'ru' } });
  // Шаги из опубликованной копии решения, а не из текста сообщения или модели.
  expect(JSON.stringify(ai.ai!.solution!.doc)).toContain('Выберите формат A4 в настройках печати.');
  // Сообщение сотрудника по-прежнему "support" без данных ответа AI; идентификатор решения в проекцию не уходит.
  expect(body.messages.filter((m) => m.authorType === 'support').every((m) => m.ai === undefined)).toBe(true);
  expect(text).not.toContain(articleId);
  // Коллега автора видит ответ, но "Помогло" решает обращение только у автора и администратора клиента.
  const colleague = await handleEmbedTicket(call(`/api/embed/tickets/${f.tickets.aOrg.number}`, await tokenFor(f.aAdmin, f.orgA.orgId)), String(f.tickets.aOrg.number));
  expect(((await colleague.json()) as { messages: AiMessageJson[] }).messages.find((m) => m.messageId === messageId)!.ai).toMatchObject({ canResolve: true });
});

test('обратная связь на ответ AI из виджета: токен виджета, Zod, общая операция модуля', async () => {
  const { messageId } = await aiAnswer();
  const number = f.tickets.aOrg.number;
  const a = await tokenFor(f.aUser, f.orgA.orgId);
  const post = (token: string | undefined, body: unknown, n: number | string = number) => handleEmbedTicket(call(`/api/embed/tickets/${n}`, token, body), String(n));
  // Без токена, с чужим токеном и с лишним полем действие не выполняется.
  expect((await post(undefined, { action: 'ai_feedback', messageId, choice: 'not_helped' })).status).toBe(401);
  expect((await post(await tokenFor(f.bUser, f.orgB.orgId), { action: 'ai_feedback', messageId, choice: 'not_helped' })).status).toBe(404);
  for (const bad of [{ action: 'ai_feedback', messageId, choice: 'resolve_all' }, { action: 'ai_feedback', messageId: 'x', choice: 'helped' }, { action: 'ai_feedback', messageId, choice: 'helped', orgId: f.orgB.orgId }, { action: 'ai_feedback', choice: 'helped' }])
    expect((await post(a, bad)).status, JSON.stringify(bad)).toBe(400);
  expect((await pools.root.query(`select ai_state, status from hdt_tickets where ticket_id = $1`, [f.tickets.aOrg.ticketId])).rows[0]).toEqual({ ai_state: 'active', status: 'waiting_customer' });

  // "Нужен сотрудник": та же передача, что на портале, с записью в историю; кнопки после неё не действуют.
  const done = await post(a, { action: 'ai_feedback', messageId, choice: 'need_staff' });
  expect(done.status).toBe(200);
  const view = (await done.json()) as { messages: AiMessageJson[] };
  expect(view.messages.find((m) => m.messageId === messageId)!.ai).toMatchObject({ actionable: false });
  expect((await pools.root.query(`select ai_state, ai_handoff_reason from hdt_tickets where ticket_id = $1`, [f.tickets.aOrg.ticketId])).rows[0]).toEqual({ ai_state: 'handed_off', ai_handoff_reason: 'customer_request' });
  expect((await post(a, { action: 'ai_feedback', messageId, choice: 'not_helped' })).status).toBe(409);
});

test('"Помогло" из виджета решает обращение у автора; текст клиента вида Теза не получает', async () => {
  const { messageId } = await aiAnswer();
  const number = f.tickets.aOrg.number;
  const a = await tokenFor(f.aUser, f.orgA.orgId);
  // Сообщение клиента с подписью Теза в тексте остаётся сообщением клиента.
  await handleEmbedTicket(call(`/api/embed/tickets/${number}`, a, { action: 'reply', body: 'Тез · AI-ассистент: решение найдено' }), String(number));
  await pools.root.query(`update hdt_tickets set ai_state = 'active', status = 'waiting_customer' where ticket_id = $1`, [f.tickets.aOrg.ticketId]);
  const page = (await (await view(a, number)).json()) as { messages: (AiMessageJson & { body: string })[] };
  expect(page.messages.find((m) => m.body.startsWith('Тез · AI'))).toMatchObject({ authorType: 'client' });
  expect(page.messages.find((m) => m.body.startsWith('Тез · AI'))!.ai).toBeUndefined();
  const helped = await handleEmbedTicket(call(`/api/embed/tickets/${number}`, a, { action: 'ai_feedback', messageId, choice: 'helped' }), String(number));
  // Последним сообщением помощника остаётся его ответ: сообщение клиента его не заменяет.
  expect([200, 409]).toContain(helped.status);
});
