import os from 'node:os';
import { stubVector } from '@/modules/hdk/embeddings/stub';
import { seedBulkIdeas, seedBulkSolutions, seedBulkTickets, seedBulkVotes } from '../integration/helpers/bulk';
import { pools } from '../integration/helpers/db';
import type { Fixture } from '../integration/isolation/fixture';

// Набор замера перед пилотом (план M9-prep, задача 4, решение 8): миллион обращений в 1000 организаций, 95% закрыты;
// 10 тысяч идей и 500 тысяч голосов; 1000 решений. Общий для замера и разбора планов медленных запросов.

export const TICKETS = 1_000_000;
export const ORGS = 1000;
export const IDEAS = 10_000;
export const VOTES = 500_000;

/** Заливает набор поверх seedTwoOrgs. page: обращение организации А с перепиской; idea: открытая идея-лидер с комментариями. */
export async function seedPilot(f: Fixture): Promise<{ page: { ticket_id: string; number: number }; idea: { idea_id: string; number: number }; summary: string }> {
  await pools.root.query(`delete from hdk_search_documents`);
  let started = performance.now();
  await seedBulkTickets(TICKETS, ORGS, f.l1.userId, { serverId: f.server.serverId, finished: true });
  const ticketsSec = (performance.now() - started) / 1000;
  // Организация А набора изоляции получает около 1000 обращений вразброс по набору: клиент видит столько же, сколько
  // обычная организация. Не одну организацию набора целиком: у seedBulkTickets номер организации зависит от остатка
  // номера, поэтому у каждой организации набора один статус и одна видимость. Обращение с перепиской для страниц обращения.
  const root = await pools.root.connect();
  try {
    await root.query(`set session_replication_role = replica`);
    await root.query(`update hdt_tickets set org_id = $1, author_id = case when number % 3 = 0 then $3::uuid else $4::uuid end where abs(hashtext(ticket_id::text)) % 1000 = $2`, [
      f.orgA.orgId,
      7,
      f.aUser.userId,
      f.aAdmin.userId,
    ]);
    await root.query(`set session_replication_role = origin`);
  } finally {
    await root.query(`set session_replication_role = origin`).catch(() => undefined);
    root.release();
  }
  const page = (await pools.root.query(`select ticket_id, number from hdt_tickets where org_id = $1 and visibility = 'org' and status = 'in_progress' order by number limit 1`, [f.orgA.orgId])).rows[0];
  await pools.root.query(
    `insert into hdt_ticket_messages (org_id, ticket_id, author_id, author_type, body, is_internal, created_on)
     select $1, $2, case when g % 2 = 0 then $3::uuid else $4::uuid end, case when g % 2 = 0 then 'client' else 'staff' end,
            'Сообщение переписки ' || g || '. ' || repeat('Текст. ', 40), g % 7 = 0, now() - ((40 - g) || ' hours')::interval
       from generate_series(1, 30) g`,
    [f.orgA.orgId, page.ticket_id, f.aUser.userId, f.l1.userId],
  );
  await pools.root.query(`analyze hdt_tickets`);

  started = performance.now();
  const orgIds = (await pools.root.query(`select org_id from hdu_organizations where external_company_id like 'bulk-%' order by org_id`)).rows.map((r) => r.org_id as string);
  await seedBulkIdeas(IDEAS, orgIds, stubVector);
  // Клиент А голосует за 300 открытых идей и следит за 20: отметки "мой голос" на доске и на странице.
  await pools.root.query(
    `insert into hdi_votes (org_id, idea_id, user_id) select $1, md5('bulk-idea-' || g)::uuid, $2 from generate_series(15, 6000, 13) g where g % 100 between 15 and 79`,
    [f.orgA.orgId, f.aUser.userId],
  );
  await pools.root.query(`insert into hdi_subscriptions (idea_id, user_id) select md5('bulk-idea-' || g)::uuid, $1 from generate_series(40, 800, 40) g`, [f.aUser.userId]);
  const votes = await seedBulkVotes(VOTES, orgIds);
  const idea = (await pools.root.query(`select idea_id, number from hdi_ideas where status = 'open' order by vote_count desc limit 1`)).rows[0];
  await pools.root.query(
    `insert into hdi_comments (org_id, idea_id, author_id, author_name, body, created_on)
     select $1, $2, $3, 'Клиент', 'Комментарий к идее ' || g, now() - ((60 - g) || ' hours')::interval from generate_series(1, 40) g`,
    [f.orgA.orgId, idea.idea_id, f.aUser.userId],
  );
  await pools.root.query(`update hdi_ideas set comment_count = 40 where idea_id = $1`, [idea.idea_id]);
  const ideasSec = (performance.now() - started) / 1000;

  started = performance.now();
  await seedBulkSolutions(1000, stubVector);
  const solutionsSec = (performance.now() - started) / 1000;
  for (const table of ['hdt_ticket_messages', 'hdi_votes', 'hdi_comments', 'hdi_subscriptions', 'hdi_ideas']) await pools.root.query(`analyze ${table}`);

  const counts = (
    await pools.root.query(
      `select (select count(*) from hdt_tickets)::int as tickets, (select count(*) filter (where status not in ('resolved', 'closed')) from hdt_tickets)::int as open,
              (select count(*) from hdi_ideas)::int as ideas, (select count(*) from hdi_votes)::int as votes, (select count(*) from hdu_organizations)::int as orgs,
              (select count(*) from hdt_tickets where org_id = $1)::int as own`,
      [f.orgA.orgId],
    )
  ).rows[0];
  const summary = `Машина: ${os.cpus()[0]?.model} x ${os.cpus().length}, память ${Math.round(os.totalmem() / 2 ** 30)} ГБ; PostgreSQL 18 в контейнере. Набор: ${counts.tickets} обращений (${counts.open} открытых, у организации А ${counts.own}) за ${ticketsSec.toFixed(0)} с; ${counts.orgs} организаций; ${counts.ideas} идей и ${votes} голосов за ${ideasSec.toFixed(0)} с; 1000 решений за ${solutionsSec.toFixed(0)} с`;
  if (counts.tickets < TICKETS || counts.ideas < IDEAS || votes < VOTES) throw new Error(`набор не залит: ${JSON.stringify(counts)}, голосов ${votes}`);
  return { page, idea, summary };
}

