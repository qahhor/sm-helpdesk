import { getAppPool } from '@/db/client';
import type { Actor } from '@/db/with-actor';
import { asActor, pools } from './db';

// Нагрузочный набор и планы запросов (аудит 23.11.2026, находки O7 и P4; план W1, задача 1).
// Обращения заливаются одной командой под суперпользователем, без триггеров: так 50 тысяч строк встают за секунды.
// Планы снимаются с настоящих запросов функций портала: тест записывает текст и параметры запросов, которые функция
// отправила в базу, и повторяет их под ролью приложения с EXPLAIN.

export type Bulk = { orgId: string; userId: string; orgs: number; tickets: number };

/** Заливает обращения: 95% закрытых, 4% открытых в разных статусах, 1% решённых; часть отложена. */
export async function seedBulkTickets(count: number, orgs: number, staffId: string): Promise<Bulk> {
  const client = await pools.root.connect();
  try {
    await client.query(`set session_replication_role = replica`);
    await client.query(`drop table if exists bulk_orgs`);
    await client.query(`create temp table bulk_orgs as select uuidv7() as org_id, g as n from generate_series(1, $1::int) g`, [orgs]);
    await client.query(
      `insert into hdt_tickets (org_id, author_id, type, impact, priority, visibility, title, description, locale, source, status, queue,
                                assignee_id, snoozed_until, resolved_on, first_response_due_on, resolution_due_on, first_responded_on,
                                client_waiting_since, created_on, modified_on)
       select o.org_id, md5('bulk-user-' || o.n || '-' || (g % 5))::uuid, 'question', 'minor', 'p3',
              case when g % 10 = 0 then 'private' else 'org' end,
              'Нагрузочное обращение ' || g, repeat('Текст нагрузочного обращения. ', 8) || g, 'ru', 'portal',
              case when g % 100 = 0 then 'new' when g % 100 = 1 then 'in_progress' when g % 100 = 2 then 'waiting_customer'
                   when g % 100 = 3 then 'resolved' when g % 100 = 4 then 'in_development' else 'closed' end,
              case when g % 200 = 1 then 'l2' else 'l1' end,
              case when g % 100 = 1 and g % 1000 = 1 then $3::uuid end,
              case when g % 2000 = 0 then now() + interval '1 day' end,
              case when g % 100 = 3 then now() - ((g % 30) || ' days')::interval end,
              now() + ((g % 500) || ' minutes')::interval, now() + ((g % 5000) || ' minutes')::interval,
              case when g % 100 <> 0 then now() - interval '1 hour' end,
              case when g % 100 in (0, 1) then now() - ((g % 300) || ' minutes')::interval end,
              now() - (g || ' minutes')::interval, now() - ((g * 7 % 400000) || ' minutes')::interval
         from generate_series(1, $1::int) g join bulk_orgs o on o.n = 1 + (g * 37 % $2::int)`,
      [count, orgs, staffId],
    );
    const picked = (await client.query<{ org_id: string; user_id: string }>(`select org_id, md5('bulk-user-' || n || '-1')::uuid as user_id from bulk_orgs where n = 7`)).rows[0];
    await client.query(`set session_replication_role = origin`);
    await client.query(`analyze hdt_tickets`);
    if (!picked) throw new Error('нагрузочный набор: организация не создана');
    return { orgId: picked.org_id, userId: picked.user_id, orgs, tickets: count };
  } finally {
    await client.query(`set session_replication_role = origin`).catch(() => undefined);
    await client.query(`drop table if exists bulk_orgs`).catch(() => undefined);
    client.release();
  }
}

export type Captured = { text: string; values: unknown[] };

/**
 * Записывает запросы, которые функция портала отправила в базу через пул приложения. Служебные команды транзакции
 * и установка актора не записываются.
 */
export async function captureQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: Captured[] }> {
  const pool = getAppPool();
  const queries: Captured[] = [];
  const original = pool.connect.bind(pool);
  // Пул отдаёт клиента с обёрткой над query: текст и параметры уходят в список.
  (pool as unknown as { connect: unknown }).connect = async () => {
    const client = await original();
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0] as string | { text: string; values?: unknown[] };
      const text = typeof first === 'string' ? first : first.text;
      const second = Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined;
      const values = typeof first === 'string' ? (second ?? []) : (first.values ?? second ?? []);
      if (!/^\s*(begin|commit|rollback)/i.test(text) && !text.includes('set_config(')) queries.push({ text, values });
      return query(...args);
    };
    const release = client.release.bind(client);
    (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
      (client as unknown as { query: unknown }).query = query;
      (client as unknown as { release: unknown }).release = release;
      return (release as (...a: unknown[]) => unknown)(...args);
    };
    return client;
  };
  try {
    return { result: await fn(), queries };
  } finally {
    (pool as unknown as { connect: unknown }).connect = original;
  }
}

/** План запроса под ролью приложения с настройками актора: как его выполнит портал. */
export async function planOf(actor: Actor, query: Captured): Promise<string> {
  return asActor(pools.app, actor, async (client) => {
    const rows = (await client.query({ text: `explain (costs off) ${query.text}`, values: query.values })).rows as Record<string, string>[];
    return rows.map((row) => Object.values(row)[0]).join('\n');
  });
}

/** Планы всех записанных запросов к таблице. */
export async function plansFor(actor: Actor, queries: Captured[], table: string): Promise<string[]> {
  const plans: string[] = [];
  // Имя таблицы в кавычках (запросы построителя) и без них (запросы текстом); чтения и изменения: план изменения
  // EXPLAIN строит, не выполняя его (итоговая проверка волны 1, замечание F10).
  const named = new RegExp(`(?:"${table}"|\\b${table}\\b)`);
  for (const query of queries.filter((q) => named.test(q.text) && /^\s*(?:select|update|delete|with)\b/i.test(q.text))) plans.push(await planOf(actor, query));
  return plans;
}

/** Заливает разобранные входящие письма: на них проверяется запрос неразобранных. */
export async function seedBulkInbound(count: number): Promise<void> {
  await pools.root.query(
    `insert into hdn_email_inbound (provider_id, from_address, subject, message_id, raw_ref, received_on, processed_on, classification)
     select 'bulk-' || g, 'bulk' || (g % 500) || '@example.uz', 'Нагрузочное письмо', '<bulk-' || g || '@example.uz>', 'bulk-' || g,
            now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, 'new'
       from generate_series(1, $1::int) g`,
    [count],
  );
  await pools.root.query(`analyze hdn_email_inbound`);
}

/** Считает транзакции, которые функция открыла в пулах приложения и библиотеки входа. */
export async function countTransactions<T>(fn: () => Promise<T>): Promise<{ result: T; app: number; auth: number }> {
  const { getAuthPool } = await import('@/db/auth-client');
  const counts = { app: 0, auth: 0 };
  const restore: (() => void)[] = [];
  for (const [name, pool] of [['app', getAppPool()], ['auth', getAuthPool()]] as const) {
    const original = pool.connect.bind(pool);
    (pool as unknown as { connect: unknown }).connect = async () => {
      const client = await original();
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const first = args[0] as string | { text: string };
        if (/^\s*begin/i.test(typeof first === 'string' ? first : first.text)) counts[name]++;
        return query(...args);
      };
      const release = client.release.bind(client);
      (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
        (client as unknown as { query: unknown }).query = query;
        (client as unknown as { release: unknown }).release = release;
        return (release as (...a: unknown[]) => unknown)(...args);
      };
      return client;
    };
    restore.push(() => void ((pool as unknown as { connect: unknown }).connect = original));
  }
  try {
    return { result: await fn(), ...counts };
  } finally {
    for (const undo of restore) undo();
  }
}

/**
 * Сколько соединений пула приложения функция держала одновременно. Больше одного значит транзакцию внутри
 * транзакции: при занятом пуле такая функция ждёт саму себя.
 */
export async function maxAppConnections<T>(fn: () => Promise<T>): Promise<{ result: T; max: number }> {
  const pool = getAppPool();
  const original = pool.connect.bind(pool);
  let held = 0;
  let max = 0;
  (pool as unknown as { connect: unknown }).connect = async () => {
    const client = await original();
    held++;
    max = Math.max(max, held);
    const release = client.release.bind(client);
    (client as unknown as { release: unknown }).release = (...args: unknown[]) => {
      held--;
      (client as unknown as { release: unknown }).release = release;
      return (release as (...a: unknown[]) => unknown)(...args);
    };
    return client;
  };
  try {
    return { result: await fn(), max };
  } finally {
    (pool as unknown as { connect: unknown }).connect = original;
  }
}

/**
 * Заливает опубликованные решения прямо в копию для читателей и поисковый индекс (замер подсказки FR-SOL-14, план M5,
 * задача 10): статья, версия, копия и строки индекса на трёх языках с векторами заглушки. Без триггеров, поэтому tsv
 * считается здесь тем же выражением, что у триггера миграции 0074. Тексты собираются из словаря, чтобы запросы
 * находили разные решения.
 */
export async function seedBulkSolutions(count: number, vectorOf: (text: string) => number[]): Promise<void> {
  const subjects = ['заказ', 'накладная', 'отчёт', 'касса', 'склад', 'возврат', 'оплата', 'договор', 'прайс', 'маршрут', 'визит', 'остаток', 'акт сверки', 'счёт', 'бонус'];
  const problems = ['не сохраняется', 'не проводится', 'печатается пустым', 'выдаёт ошибку', 'не загружается', 'показывает старые данные', 'зависает', 'не отправляется'];
  const reasons = ['закрыт период', 'нет прав у роли', 'не хватает остатка', 'не заполнен склад', 'устарел курс валюты', 'нет связи с сервером', 'не указан договор'];
  const rows: { title: string; body: string; locale: string }[] = [];
  for (let i = 0; i < count; i++) {
    const title = `${subjects[i % subjects.length]} ${problems[(i * 7) % problems.length]}: ${reasons[(i * 3) % reasons.length]} (${i})`;
    const body = `При работе ${subjects[i % subjects.length]} ${problems[(i * 7) % problems.length]}. Причина: ${reasons[(i * 3) % reasons.length]}. Откройте настройки и проверьте раздел ${subjects[(i + 3) % subjects.length]}.`;
    for (const locale of ['ru', 'uz', 'en']) rows.push({ title, body, locale });
  }
  const client = await pools.root.connect();
  try {
    await client.query(`set session_replication_role = replica`);
    const articles = await client.query<{ article_id: string; number: string }>(
      `insert into hdk_articles (original_locale, audience) select 'ru', case when g % 10 = 0 then 'internal' else 'clients' end from generate_series(1, $1::int) g returning article_id, number`,
      [count],
    );
    for (let start = 0; start < rows.length; start += 600) {
      const batch = rows.slice(start, start + 600);
      const articleIds = batch.map((_, j) => articles.rows[Math.floor((start + j) / 3)]!.article_id);
      await client.query(
        `with input as (
           select * from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) as t(article_id, locale, title, body, vec)
         ), v as (
           insert into hdk_article_versions (article_id, locale, number, title, doc, state)
           select article_id, locale, 1, title, '{"version":1,"blocks":[]}', 'published' from input returning version_id, article_id, locale
         ), p as (
           insert into hdk_published (article_id, version_id, article_number, locale, audience, title, doc, body_text, slug, original_locale)
           select i.article_id, v.version_id, a.number, i.locale, a.audience, i.title, '{"version":1,"blocks":[]}', i.body, 'bulk-' || a.number, 'ru'
             from input i join v on v.article_id = i.article_id and v.locale = i.locale join hdk_articles a on a.article_id = i.article_id
           returning published_id, article_id, locale, audience, title, body_text
         )
         insert into hdk_search_documents (published_id, ref_id, kind, article_type, locale, title, body_text, audience, tsv, embedding)
         select p.published_id, p.article_id, 'article', 'solution', p.locale, p.title, p.body_text, p.audience,
                setweight(to_tsvector(app.hdk_text_config(p.locale), app.hdk_search_text(p.locale, p.title)), 'A')
                || setweight(to_tsvector(app.hdk_text_config(p.locale), app.hdk_search_text(p.locale, p.body_text)), 'B'),
                i.vec::vector
           from p join input i on i.article_id = p.article_id and i.locale = p.locale`,
        [articleIds, batch.map((r) => r.locale), batch.map((r) => r.title), batch.map((r) => r.body), batch.map((r) => `[${vectorOf(`${r.title}\n${r.body}`).join(',')}]`)],
      );
    }
    await client.query(`set session_replication_role = origin`);
    await client.query(`analyze hdk_search_documents`);
    await client.query(`analyze hdk_published`);
  } finally {
    await client.query(`set session_replication_role = origin`).catch(() => undefined);
    client.release();
  }
}
