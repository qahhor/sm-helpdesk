import { beforeEach, expect, test } from 'vitest';
import { replyAddress } from '@/modules/hdn/inbound/reply-address';
import { intakeEmail } from '@/modules/hdt/api/email-intake';
import { sweepAttachments } from '@/modules/hdt/api/jobs';
import { deliver as deliverTo, inboundPerTest, type Letter, receive, REPLY, SYSTEM } from './helpers/inbound';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Файлы письма кладутся в хранилище до транзакции (аудит 23.11.2026, находка P10; M4, мелкое 6; план W2, задача 5).
// Раньше файл загружался внутри транзакции, под блокировкой обращения и письма: медленное хранилище держало
// блокировку, и ответы сотрудника в это обращение ждали.

const box = inboundPerTest();
let f: Fixture;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const file = (name: string) => ({ filename: name, contentType: 'image/png', data: PNG });

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`update auth."user" set email = 'a-user@example.uz', "emailVerified" = true where id = $1`, [f.aUser.userId]);
});
const deliver = (letter: Letter) => deliverTo(box, letter);
const signedTo = (number: number, userId: string) => replyAddress(number, userId, REPLY);

/** Свободна ли строка: другой запрос может взять её блокировку сразу. */
async function unlocked(sql: string, values: unknown[]): Promise<boolean> {
  const client = await pools.root.connect();
  try {
    await client.query('begin');
    await client.query(`${sql} for update nowait`, values);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') return false;
    throw error;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

test('ответ письмом с файлами: во время загрузки в хранилище обращение и письмо не заблокированы', async () => {
  const t = f.tickets.aOrg;
  const seen: boolean[] = [];
  const put = box.storage.put.bind(box.storage);
  box.storage.put = async (key, data, mime) => {
    seen.push(await unlocked(`select 1 from hdt_tickets where ticket_id = $1`, [t.ticketId]));
    seen.push(await unlocked(`select 1 from hdn_email_inbound where processed_on is null`, []));
    return put(key, data, mime);
  };
  expect((await deliver({ to: [signedTo(t.number, f.aUser.userId)], text: 'Вот снимки', attachments: [file('a.png'), file('b.png')] })).result).toBe('reply');
  expect(seen).toEqual([true, true, true, true]);
  const rows = (await pools.root.query(`select file_name, scan_status, storage_key, attachment_id, message_id from hdt_attachments where ticket_id = $1 and message_id is not null order by file_name`, [t.ticketId])).rows;
  expect(rows.map((r) => r.file_name)).toEqual(['a.png', 'b.png']);
  for (const row of rows) {
    expect(row.storage_key).toBe(`quarantine/${row.attachment_id}`);
    expect(await box.storage.head(row.storage_key)).toBeTruthy();
  }
  expect(box.jobs.sent.filter((j) => j.name === 'attachment.scan')).toHaveLength(2);
});

test('новое обращение из письма с файлом: во время загрузки письмо не заблокировано, файл прикреплён к обращению', async () => {
  const seen: boolean[] = [];
  const put = box.storage.put.bind(box.storage);
  box.storage.put = async (key, data, mime) => {
    seen.push(await unlocked(`select 1 from hdn_email_inbound where processed_on is null`, []));
    return put(key, data, mime);
  };
  expect((await deliver({ subject: 'Не печатается накладная', text: 'Смотрите снимок', attachments: [file('shot.png')] })).result).toBe('new');
  expect(seen).toEqual([true]);
  const rows = (await pools.root.query(`select a.file_name, t.title from hdt_attachments a join hdt_tickets t using (ticket_id) where a.file_name = 'shot.png'`)).rows;
  expect(rows).toEqual([{ file_name: 'shot.png', title: 'Не печатается накладная' }]);
});

test('повторный разбор уже разобранного письма файлы не загружает', async () => {
  const t = f.tickets.aOrg;
  const first = await deliver({ to: [signedTo(t.number, f.aUser.userId)], text: 'Вот снимок', attachments: [file('a.png')] });
  let puts = 0;
  const put = box.storage.put.bind(box.storage);
  box.storage.put = async (key, data, mime) => {
    puts += 1;
    return put(key, data, mime);
  };
  expect(await intakeEmail(SYSTEM, first.inboundId)).toBe('reply');
  expect(puts).toBe(0);
  expect((await pools.root.query(`select count(*)::int as n from hdt_attachments where file_name = 'a.png'`)).rows[0].n).toBe(1);
});

test('письмо, которое успел разобрать другой процесс, не оставляет загруженных файлов без обращения', async () => {
  const t = f.tickets.aOrg;
  const letter = { to: [signedTo(t.number, f.aUser.userId)], text: 'Вот снимок', attachments: [file('a.png')] };
  const { inboundId } = await receive(box, letter);
  // Второй процесс разбирает то же письмо, пока первый загружает файл.
  const put = box.storage.put.bind(box.storage);
  let raced = false;
  box.storage.put = async (key, data, mime) => {
    const stored = await put(key, data, mime);
    if (!raced) {
      raced = true;
      await intakeEmail(SYSTEM, inboundId);
    }
    return stored;
  };
  await intakeEmail(SYSTEM, inboundId);
  box.storage.put = put;
  // Одно сообщение и один прикреплённый файл; лишняя загрузка убрана сразу или первым проходом очистки.
  expect((await pools.root.query(`select count(*)::int as n from hdt_ticket_messages where ticket_id = $1 and source = 'email'`, [t.ticketId])).rows[0].n).toBe(1);
  expect((await pools.root.query(`select count(*)::int as n from hdt_attachments where file_name = 'a.png' and ticket_id is not null`)).rows[0].n).toBe(1);
  await pools.root.query(`begin; set local session_replication_role = replica; update hdt_attachments set created_on = now() - interval '2 days' where ticket_id is null; commit`);
  await sweepAttachments({ type: 'system', job: 'attachment.sweep' });
  const all = (await pools.root.query(`select attachment_id, ticket_id from hdt_attachments where file_name = 'a.png'`)).rows;
  expect(all).toHaveLength(1);
  const kept = `quarantine/${all[0].attachment_id}`;
  expect([...box.storage.objects.keys()].filter((key) => key.startsWith('quarantine/'))).toEqual([kept]);
});
