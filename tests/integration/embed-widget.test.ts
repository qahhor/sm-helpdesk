import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MemoryJobQueue, MemoryStorage, setJobQueueForTests, setStorageForTests } from '@/modules/hdc/testing';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { publishSolution } from '@/modules/hdk/api/publish';
import { runIndexJob } from '@/modules/hdk/api/search-jobs';
import { handleEmbedSolution, handleWidgetSuggest, recordWidgetSuggestTicket } from '@/modules/hdk/api/widget';
import { setEmbedderForTests } from '@/modules/hdk/embeddings';
import { createStubEmbedder } from '@/modules/hdk/embeddings/stub';
import { ticketErrorSignature } from '@/modules/hdk/signature';
import { handleUploadRequest } from '@/modules/hdt/api';
import { handleEmbedForm, handleEmbedTickets } from '@/modules/hdt/api/embed';
import { signEmbedToken } from '@/modules/hdu/core/embed-token';
import { staffCtx, staffWithRole } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// API страницы "Сообщить" в виджете (план M6, задача 5; FR-WG-03, 06, FR-SOL-15, S1; решения 10-14 и 16).
// Только токен виджета в заголовке Authorization; организация и пользователь только из токена; источник обращения по
// платформе токена; контекст из подсказок только текстом; пределы те же, что на портале. Раздел "На что смотреть",
// пункты 4, 7 и 8.

const HUB = process.env.HUB_URL as string;
const SECRET = process.env.EMBED_TOKEN_SECRET as string;
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  // Виджет у сервера набора включён: без режима ключей токены виджета не действуют (проверка M6, M3).
  await pools.root.query(`update hdu_servers set context_key_mode = 'jwks', context_jwks_url = 'https://keys.smartup.example/jwks' where server_id = $1`, [f.server.serverId]);
  setStorageForTests(new MemoryStorage());
  setJobQueueForTests(new MemoryJobQueue());
  setEmbedderForTests(createStubEmbedder());
  await pools.root.query(`insert into hdc_settings (code, value) values ('kb.allowed_domains', '["smartup.uz"]') on conflict do nothing`);
});
afterEach(() => {
  setStorageForTests(null);
  setJobQueueForTests(null);
  setEmbedderForTests(null);
});

type Member = { userId: string };
const tokenFor = (member: Member, orgId: string, platform: 'web' | 'android' | 'ios' = 'web', now?: Date) =>
  signEmbedToken({ userId: member.userId, orgId, serverId: f.server.serverId, platform }, { secret: SECRET, issuer: HUB }, now);

function call(path: string, opts: { token?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  return new Request(`${HUB}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(opts.body !== undefined && { 'content-type': 'application/json', origin: HUB }),
      ...(opts.token && { authorization: `Bearer ${opts.token}` }),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const createTicket = (token: string, body: unknown) => handleEmbedTickets(call('/api/embed/tickets', { token, body }), { afterCreate: recordWidgetSuggestTicket });
const report = (extra: Record<string, unknown> = {}) => ({ description: 'Сохранял заказ, выскочила ошибка', locale: 'ru', ...extra });

test('без токена виджета, с чужой подписью, просроченным и чужим токеном API виджета отвечает 401 и не ставит кук', async () => {
  const valid = await tokenFor(f.aUser, f.orgA.orgId);
  const forged = await signEmbedToken({ userId: f.aUser.userId, orgId: f.orgA.orgId, serverId: f.server.serverId, platform: 'web' }, { secret: 'x'.repeat(40), issuer: HUB });
  const expired = await tokenFor(f.aUser, f.orgA.orgId, 'web', new Date(Date.now() - 16 * 60 * 1000));
  // Токен с тем же секретом, но для другого получателя (подмена назначения).
  const otherAudience = await new SignJWT({ org: f.orgA.orgId, srv: f.server.serverId, plt: 'web' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(HUB)
    .setAudience('smartup-hub')
    .setSubject(f.aUser.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(SECRET));
  for (const token of [undefined, forged, expired, otherAudience, 'not.a.token']) {
    const responses = [
      await handleEmbedForm(call('/api/embed/form', { token })),
      await createTicket(token as string, report()),
      await handleWidgetSuggest(call('/api/suggest', { token, body: { text: 'ошибка при сохранении заказа', sessionId: randomUUID(), locale: 'ru' } })),
      await handleEmbedSolution(call('/api/embed/solutions/1', { token }), '1'),
    ];
    for (const response of responses) {
      expect(response.status, String(token).slice(0, 12)).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  }
  expect((await handleEmbedForm(call('/api/embed/form?locale=ru', { token: valid }))).status).toBe(200);
  // Ни одного обращения не создано отказами.
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets where source like 'widget%'`)).rows[0].n).toBe(0);
});

test('отключённый участник с действующим токеном виджета получает 403', async () => {
  const token = await tokenFor(f.aUser, f.orgA.orgId);
  await pools.root.query(`update hdu_memberships set state = 'passive' where user_id = $1`, [f.aUser.userId]);
  expect((await createTicket(token, report())).status).toBe(403);
});

test('обращение из виджета: организация и автор из токена, источник по платформе, контекст из подсказок только текстом', async () => {
  const web = await tokenFor(f.aUser, f.orgA.orgId, 'web');
  const xss = '<img src=x onerror=alert(1)> javascript:alert(document.cookie)';
  const response = await createTicket(
    web,
    report({ context: { moduleCode: 'orders', screen: 'order_edit', version: '5.12.0', errorCode: 'ORA-20001', errorText: `${xss}\u0000` } }),
  );
  expect(response.status).toBe(201);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  const { number } = (await response.json()) as { number: number };
  const row = (await pools.root.query(`select org_id, author_id, source, context, error_signature, title from hdt_tickets where number = $1`, [number])).rows[0];
  expect(row).toMatchObject({ org_id: f.orgA.orgId, author_id: f.aUser.userId, source: 'widget_web' });
  // Платформа из токена, текст ошибки как есть (только без управляющих знаков): выводится всегда текстом.
  expect(row.context).toEqual({ moduleCode: 'orders', screen: 'order_edit', version: '5.12.0', errorCode: 'ORA-20001', errorText: xss, platform: 'web' });
  // Сигнатура из кода и текста ошибки контекста (решение 0055), модуль в неё не входит (решение 10).
  expect(row.error_signature).toBe(ticketErrorSignature({ context: { errorCode: 'ORA-20001', errorText: xss }, description: '' })?.signature);
  const audit = (await pools.root.query(`select diff from hdc_audit_log where action = 'ticket.created' and org_id = $1 order by created_on desc limit 1`, [f.orgA.orgId])).rows[0];
  expect(audit.diff).toMatchObject({ source: 'widget_web' });

  const android = await tokenFor(f.aUser, f.orgA.orgId, 'android');
  const mobile = (await (await createTicket(android, report())).json()) as { number: number };
  expect((await pools.root.query(`select source, context from hdt_tickets where number = $1`, [mobile.number])).rows[0]).toEqual({ source: 'widget_mobile', context: { platform: 'android' } });
});

test('тело запроса не задаёт организацию, автора, платформу и источник: лишние поля отклоняются', async () => {
  const token = await tokenFor(f.aUser, f.orgA.orgId);
  for (const extra of [{ orgId: f.orgB.orgId }, { authorId: f.bUser.userId }, { source: 'staff' }, { context: { platform: 'ios' } }, { context: { moduleCode: 'bad code<script>' } }, { title: 'x' }])
    expect((await createTicket(token, report(extra))).status, JSON.stringify(extra)).toBe(400);
  expect((await pools.root.query(`select count(*)::int as n from hdt_tickets where org_id = $1`, [f.orgB.orgId])).rows[0].n).toBe(2);
  // Модуль из чужого справочника или неактивный: отказ, а не молчаливое сохранение.
  expect((await createTicket(token, report({ moduleId: randomUUID() }))).status).toBe(400);
});

test('предел создания обращений тот же, что на портале: 10 в час на пользователя', async () => {
  const token = await tokenFor(f.aUser, f.orgA.orgId);
  for (let i = 0; i < 10; i++) expect((await createTicket(token, report())).status).toBe(201);
  const limited = await createTicket(token, report());
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
});

async function publish(title: string, what: string, audience: 'clients' | 'internal' = 'clients') {
  let serial = 0;
  const p = (text: string) => ({ type: 'paragraph' as const, attrs: { id: `wdg${title.length}${String(++serial).padStart(6, '0')}` }, content: [{ type: 'text' as const, text }] });
  const moduleId = (await pools.root.query(`insert into hdr_product_modules (code, name) values ($1, '{"ru": "Заказы"}') returning module_id`, [`wdg-${randomUUID()}`])).rows[0].module_id;
  const step = { type: 'step' as const, attrs: { id: `wdg${title.length}step0001` }, content: [p('Откройте Склад и проверьте остаток товара')] };
  const created = await createDraftArticle(staffCtx(f.l1), { locale: 'ru', title, audience, moduleId, doc: { version: 1 as const, blocks: [p(what), step] } });
  const state = await solutionEditorState(staffCtx(f.l1), { number: created.number });
  const l2 = staffCtx(await staffWithRole('agent_l2'));
  const outcome = await publishSolution(l2, { number: created.number, locale: 'ru', versionId: state!.current.versionId, revision: state!.current.revision, confirmFindings: false });
  expect(outcome.status).toBe('published');
  await runIndexJob({ type: 'system', job: 'kb.index' }, { articleId: created.articleId });
  return created;
}

test('"Мы знаем эту ошибку": точное совпадение по ошибке из Smartup без описания, исход с зоной widget', async () => {
  const s = await publish('Заказ не сохраняется: нет остатка на складе', 'При сохранении заказа выходит ошибка о нехватке остатка');
  const signature = ticketErrorSignature({ context: { errorCode: 'ORA-20001', errorText: 'нет остатка на складе 12' }, description: '' })!.signature;
  await pools.root.query(`insert into hdk_error_signatures (signature, article_id, sample_code) values ($1, $2, 'ORA-20001')`, [signature, s.articleId]);
  const token = await tokenFor(f.aUser, f.orgA.orgId);
  const sessionId = randomUUID();
  const response = await handleWidgetSuggest(
    call('/api/suggest', { token, body: { text: '', sessionId, locale: 'ru', errorCode: 'ORA-20001', errorText: 'нет остатка на складе 57' } }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: { number: number; exact: boolean }[] };
  expect(body.items).toEqual([expect.objectContaining({ number: s.number, exact: true })]);
  expect((await pools.root.query(`select zone, outcome from hdk_deflection_events where session_id = $1`, [sessionId])).rows).toEqual([{ zone: 'widget', outcome: 'left' }]);

  // Решение в панели: текст из hdk_published, "Помогло" с сессией формы.
  const page = await handleEmbedSolution(call(`/api/embed/solutions/${s.number}?locale=ru`, { token }), String(s.number));
  expect(await page.json()).toMatchObject({ kind: 'solution', number: s.number, title: 'Заказ не сохраняется: нет остатка на складе' });
  const helped = await handleEmbedSolution(call(`/api/embed/solutions/${s.number}`, { token, body: { outcome: 'not_helped', sessionId } }), String(s.number));
  expect(helped.status).toBe(200);
  expect((await pools.root.query(`select outcome from hdk_deflection_events where session_id = $1`, [sessionId])).rows[0].outcome).toBe('not_helped');

  // Обращение после подсказки: исход ticket_created той же сессии.
  const created = (await (await createTicket(token, report({ suggestSession: sessionId, context: { errorCode: 'ORA-20001', errorText: 'нет остатка на складе 57' } }))).json()) as { number: number };
  const ticketId = (await pools.root.query(`select ticket_id from hdt_tickets where number = $1`, [created.number])).rows[0].ticket_id;
  expect((await pools.root.query(`select outcome, ticket_id from hdk_deflection_events where session_id = $1`, [sessionId])).rows[0]).toEqual({ outcome: 'ticket_created', ticket_id: ticketId });
});

test('подсказка не находит текст обращений и внутренние решения, внутреннее решение в панели не открывается', async () => {
  const internal = await publish('Сброс очереди обмена с кассой', 'Очередь обмена с кассой зависла', 'internal');
  const token = await tokenFor(f.aUser, f.orgA.orgId);
  for (const text of ['Секрет Б: накладная не проводится', 'очередь обмена с кассой зависла'])
    expect(await (await handleWidgetSuggest(call('/api/suggest', { token, body: { text, sessionId: randomUUID(), locale: 'ru' } }))).json()).toEqual({ items: [], limited: false });
  expect((await handleEmbedSolution(call(`/api/embed/solutions/${internal.number}`, { token }), String(internal.number))).status).toBe(404);
  // Лишние поля подсказки (организация из тела) отклоняются схемой.
  expect((await handleWidgetSuggest(call('/api/suggest', { token, body: { text: 'ошибка заказа склад', sessionId: randomUUID(), locale: 'ru', orgId: f.orgB.orgId } }))).status).toBe(400);
});

test('предел подсказки тот же, что на портале: сверх него подсказка пуста, форма работает', async () => {
  const token = await tokenFor(f.aUser, f.orgA.orgId);
  const ask = () => handleWidgetSuggest(call('/api/suggest', { token, body: { text: 'ошибка при сохранении заказа на складе', sessionId: randomUUID(), locale: 'ru' } }));
  for (let i = 0; i < 60; i++) expect((await ask()).status).toBe(200);
  expect(await (await ask()).json()).toEqual({ items: [], limited: true });
});

test('скриншот: ссылка на загрузку по токену виджета, сессия портала не нужна, файл принадлежит пользователю токена', async () => {
  const token = await tokenFor(f.aUser, f.orgA.orgId);
  const presign = await handleUploadRequest(call('/api/uploads/presign', { token, body: { fileName: 'screen.png', size: 1200, mime: 'image/png' } }), 'presign');
  expect(presign.status).toBe(200);
  const { attachmentId } = (await presign.json()) as { attachmentId: string };
  expect((await pools.root.query(`select org_id, uploader_id from hdt_attachments where attachment_id = $1`, [attachmentId])).rows[0]).toEqual({ org_id: f.orgA.orgId, uploader_id: f.aUser.userId });
  // Неверный токен не превращается во вход по сессии: 401.
  expect((await handleUploadRequest(call('/api/uploads/presign', { token: 'bad.token.value', body: { fileName: 'a.png', size: 10 } }), 'presign')).status).toBe(401);
});
