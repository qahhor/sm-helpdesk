import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { contentDisposition } from '@/modules/hdc/api';
import { MemoryStorage, setStorageForTests } from '@/modules/hdc/testing';
import { attachmentRedirect, attachmentResponse } from '@/modules/hdt/api';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { seedTwoOrgs } from './isolation/fixture';

// Выдача вложений после проверки (FR-TK-13, раздел 14.3, строка 15.2; план M2, задача 8).

beforeEach(() => setStorageForTests(new MemoryStorage()));
afterEach(() => setStorageForTests(null));

/** Вложение обращения напрямую в базу: состояние проверки и тип задаёт тест. */
async function attach(
  ticket: { ticketId: string },
  orgId: string,
  uploaderId: string,
  opts: { status?: string; fileName?: string; mime?: string; internal?: boolean } = {},
): Promise<string> {
  const r = await pools.root.query(
    `insert into hdt_attachments (org_id, ticket_id, uploader_id, storage_key, file_name, mime, size, scan_status, is_internal)
     values ($1, $2, $3, $8, $4, $5, 10, $6, $7) returning attachment_id`,
    [orgId, ticket.ticketId, uploaderId, opts.fileName ?? 'shot.png', opts.mime ?? 'image/png', opts.status ?? 'clean', opts.internal ?? false, `files/${orgId}/${randomUUID()}`],
  );
  return r.rows[0].attachment_id as string;
}
const params = (url: string | null) => new URL(url ?? 'https://none.test').searchParams;

test('вложение обращения Б: 404, как несуществующее (15.2)', async () => {
  const f = await seedTwoOrgs();
  const theirs = await attach(f.tickets.bOrg, f.orgB.orgId, f.bUser.userId);
  const ctx = await clientCtx(f.aUser);
  for (const id of [theirs, '0192d2a4-0000-7000-8000-00000000ffff', 'не идентификатор'])
    expect(await attachmentRedirect(ctx, id, { inline: false }), id).toBeNull();
  // Вложение личного обращения коллеги тоже не выдаётся.
  expect(await attachmentRedirect(ctx, await attach(f.tickets.aPrivate, f.orgA.orgId, f.aAdmin.userId), { inline: false })).toBeNull();
  // Своё Б получает.
  expect(await attachmentRedirect(await clientCtx(f.bUser), theirs, { inline: false })).toMatch(/^https:\/\/storage\.test\/files\//);
  // Обработчик: без сессии 401, чужое и несуществующее 404 с одинаковым телом.
  expect((await attachmentResponse(null, theirs, false)).status).toBe(401);
  const alien = await attachmentResponse(ctx, theirs, false);
  const missing = await attachmentResponse(ctx, '0192d2a4-0000-7000-8000-00000000ffff', false);
  expect([alien.status, missing.status]).toEqual([404, 404]);
  expect(await alien.text()).toBe(await missing.text());
});

test('pending, infected и rejected не выдаются никому из клиентов', async () => {
  const f = await seedTwoOrgs();
  for (const status of ['pending', 'infected', 'rejected']) {
    const id = await attach(f.tickets.aOrg, f.orgA.orgId, f.aUser.userId, { status });
    // Даже загрузившему.
    for (const member of [f.aUser, f.aAdmin]) expect(await attachmentRedirect(await clientCtx(member), id, { inline: false }), `${status}`).toBeNull();
  }
});

test('ссылка на 60 секунд, Content-Disposition: attachment, имя файла в UTF-8 без путей и кавычек', async () => {
  const f = await seedTwoOrgs();
  const id = await attach(f.tickets.aOrg, f.orgA.orgId, f.aAdmin.userId, { fileName: 'C:\\Users\\a\\отчёт "ноябрь".pdf', mime: 'application/pdf' });
  const ctx = await clientCtx(f.aUser);
  const url = await attachmentRedirect(ctx, id, { inline: false });
  expect(params(url).get('ttl')).toBe('60');
  // Тип ответа задаёт портал по строке вложения (вторая проверка M2).
  expect(params(url).get('type')).toBe('application/pdf');
  const disposition = params(url).get('disposition') ?? '';
  expect(disposition).toBe(contentDisposition('attachment', 'отчёт "ноябрь".pdf'));
  expect(disposition).not.toMatch(/Users|\\/);
  // Внутри кавычек запасного имени нет кавычек, точное имя закодировано.
  expect(/filename="([^"]*)"/.exec(disposition)?.[1]).toBe('_____ ________.pdf');
  expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('отчёт "ноябрь".pdf')}`);
  // Обработчик отвечает 303 на ссылку и не даёт её кешировать.
  const response = await attachmentResponse(ctx, id, false);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toMatch(/^https:\/\/storage\.test\//);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

test('inline только для растровых картинок; PDF, SVG и HTML всегда attachment', async () => {
  const f = await seedTwoOrgs();
  const ctx = await clientCtx(f.aUser);
  const dispositionOf = async (fileName: string, mime: string) =>
    params(await attachmentRedirect(ctx, await attach(f.tickets.aOrg, f.orgA.orgId, f.aUser.userId, { fileName, mime }), { inline: true })).get('disposition');
  for (const [name, mime] of [
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
  ])
    expect(await dispositionOf(name, mime), mime).toMatch(/^inline; /);
  for (const [name, mime] of [
    ['a.pdf', 'application/pdf'],
    ['a.svg', 'image/svg+xml'],
    ['a.html', 'text/html'],
    ['a.heic', 'image/heic'],
  ])
    expect(await dispositionOf(name, mime), mime).toMatch(/^attachment; /);
});

test('внутреннее вложение клиенту: 404', async () => {
  const f = await seedTwoOrgs();
  const id = await attach(f.tickets.aOrg, f.orgA.orgId, f.aUser.userId, { internal: true });
  for (const member of [f.aUser, f.aAdmin]) {
    expect(await attachmentRedirect(await clientCtx(member), id, { inline: false })).toBeNull();
    expect((await attachmentResponse(await clientCtx(member), id, false)).status).toBe(404);
  }
});
