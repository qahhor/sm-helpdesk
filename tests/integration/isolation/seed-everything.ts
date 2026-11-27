import type { AgentActor } from '@/db/with-actor';
import { pools } from '../helpers/db';
import { SEALED, seedTwoOrgs } from './fixture';

// Строки во все таблицы, чтобы "пусто" означало "закрыто политикой", а не "в таблице ничего нет".
export async function seedEverything() {
  const f = await seedTwoOrgs();
  await pools.root.query(`insert into hdr_product_modules (code, name) values ('orders', '{"ru": "Заказы"}')`);
  await pools.root.query(`insert into hdc_settings (code, value) values ('ai.enabled', 'true')`);
  await pools.root.query(`insert into hdr_business_calendars (code, timezone, week_hours) values ('default', 'Asia/Tashkent', '{"0": null}')`);
  await pools.root.query(`insert into hdt_saved_filters (owner_id, name, query) values ($1, 'Мои', '{"queue": "mine"}')`, [f.l1.userId]);
  await pools.root.query(`insert into hdt_ticket_reads (ticket_id, user_id, seen_on) values ($1, $2, now())`, [f.tickets.aOrg.ticketId, f.l1.userId]);
  await pools.root.query(
    `insert into hdt_ticket_line_transfers (ticket_id, from_line, to_line, reason_code, checked, needed, by_user, pickup_due_on)
     values ($1, 'l1', 'l2', 'other', 'Проверено', 'Нужно', $2, now())`,
    [f.tickets.aOrg.ticketId, f.l1.userId],
  );
  await pools.root.query(`insert into hdr_reply_templates (shortcut, title, body) values ('greet', 'Приветствие', '{"ru": "Здравствуйте"}')`);
  await pools.root.query(`insert into hdr_l1_playbooks (ticket_type, body, owner_id) values ('bug', '- Версия', $1)`, [f.care.userId]);
  await pools.root.query(`insert into hdt_reply_drafts (ticket_id, user_id, body) values ($1, $2, 'Черновик')`, [f.tickets.aOrg.ticketId, f.l1.userId]);
  await pools.root.query(`insert into hdt_ticket_presence (ticket_id, user_id, mode, expires_on) values ($1, $2, 'viewing', now() + interval '1 minute')`, [
    f.tickets.aOrg.ticketId,
    f.l1.userId,
  ]);
  await pools.root.query(
    `insert into hdt_mentions (message_id, user_id) select message_id, $2 from hdt_ticket_messages where ticket_id = $1 and is_internal limit 1`,
    [f.tickets.aOrg.ticketId, f.care.userId],
  );
  await pools.root.query(
    `insert into hdr_sla_policies (priority, first_response_minutes, resolution_minutes, calendar_id) select 'p1', 15, 180, calendar_id from hdr_business_calendars`,
  );
  await pools.root.query(
    `insert into hdc_audit_log (org_id, actor_type, action, object_type) values ($1, 'system', 'org.provisioned', 'organization')`,
    [f.orgA.orgId],
  );
  await pools.root.query(`insert into hdc_rate_limits (code, window_on, hits) values ('x:1', now(), 1)`);
  await pools.root.query(`insert into hdc_ops_alerts (code, last_sent_on) values ('outbox_failed', now())`);
  await pools.root.query(`insert into hdc_ops_backups (kind, size_bytes, finished_on) values ('dump', 1024, now())`);
  await pools.root.query(`insert into hdc_ops_heartbeats (process, beat_on) values ('worker', now()) on conflict do nothing`);
  await pools.root.query(`insert into hdc_ops_host_marks (host, disk_pct, mem_pct, cpu_pct, marked_on) values ('hub-test', 10, 20, 30, now()) on conflict do nothing`);
  await pools.root.query(
    `insert into hdu_email_tokens (user_id, email, token_hash, expires_on)
     values ($1, 'a@acme.test', encode(sha256('t'::bytea), 'hex'), now() + interval '1 hour')`,
    [f.aUser.userId],
  );
  await pools.root.query(
    `insert into hdu_contact_identities (user_id, kind, external_id, display_name, verified, verified_on)
     values ($1, 'telegram', '777001', '@a', 'linked', now()), ($2, 'telegram', '777002', '@b', 'linked', now())`,
    [f.aUser.userId, f.bUser.userId],
  );
  await pools.root.query(
    `insert into hdu_link_codes (user_id, kind, code_hash, expires_on) values ($1, 'telegram', encode(sha256('l'::bytea), 'hex'), now() + interval '10 minutes')`,
    [f.aUser.userId],
  );
  await pools.root.query(
    `insert into hdu_login_codes (user_id, channel, code_hash, expires_on) values ($1, 'telegram', encode(sha256('g'::bytea), 'hex'), now() + interval '10 minutes')`,
    [f.aUser.userId],
  );
  await pools.root.query(`insert into hdn_telegram_updates (update_id) values (1)`);
  await pools.root.query(`insert into hdc_domain_events (org_id, ticket_id, kind) values ($1, $2, 'ticket_created')`, [f.orgA.orgId, f.tickets.aOrg.ticketId]);
  await pools.root.query(
    `with tag as (insert into hdr_tags (name, color) values ('Срочно', 'red') returning tag_id)
     insert into hdt_ticket_tags (org_id, ticket_id, tag_id, added_by) select $1, $2, tag_id, $3 from tag`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId, f.l1.userId],
  );
  await pools.root.query(
    `with rule as (insert into hdw_rules (name, event, actions, order_no) values ('Срочные', 'ticket_created', '[{"action": "set_queue", "queue": "care"}]', 1) returning rule_id)
     insert into hdw_rule_runs (org_id, rule_id, ticket_id, result) select $1, rule_id, $2, 'applied' from rule`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId],
  );
  await pools.root.query(
    `with endpoint as (insert into hdw_webhook_endpoints (name, url, events) values ('Учёт', 'https://hooks.partner.example/in', '{ticket_created}') returning endpoint_id),
          secret as (insert into hdw_webhook_secrets (endpoint_id, sealed) select endpoint_id, $3 from endpoint)
     insert into hdw_webhook_deliveries (org_id, endpoint_id, ticket_id, kind, body) select $1, endpoint_id, $2, 'ticket_created', '{"event": "ticket_created"}' from endpoint`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId, SEALED],
  );
  await pools.root.query(`insert into hdw_macros (name, actions, order_no) values ('Запросить версию', '[{"action": "set_status", "status": "waiting_customer"}]', 1)`);
  await pools.root.query(
    `with task as (insert into hdw_dev_tasks (tracker, external_id, url, title) values ('manual', 'DEV-501', 'https://tracker.smartup.example/tasks/DEV-501', 'Отчёт не грузится') returning dev_task_id)
     insert into hdw_dev_task_links (org_id, dev_task_id, ticket_id) select $1, dev_task_id, $2 from task`,
    [f.orgA.orgId, f.tickets.aOrg.ticketId],
  );
  await pools.root.query(`insert into hdu_server_checks (server_id, is_ok, issues) values ($1, false, '{timeout}')`, [f.server.serverId]);
  await pools.root.query(`insert into hdu_context_token_uses (server_id, jti, expires_on) values ($1, 'jti-1', now() + interval '5 minutes')`, [f.server.serverId]);
  // Знания: по решению для клиентов и "только через сотрудника", чтобы проверка аудитории что-то значила.
  for (const audience of ['clients', 'internal']) {
    const a = (await pools.root.query(`insert into hdk_articles (audience, original_locale) values ($1, 'ru') returning article_id, number`, [audience])).rows[0];
    const doc = { version: 1, blocks: [] };
    const v = (
      await pools.root.query(`insert into hdk_article_versions (article_id, locale, number, title, doc, state) values ($1, 'ru', 1, 'Решение', $2, 'published') returning version_id`, [
        a.article_id,
        doc,
      ])
    ).rows[0].version_id;
    await pools.root.query(`insert into hdk_article_translations (article_id, locale, published_version_id, slug) values ($1, 'ru', $2, 'reshenie')`, [a.article_id, v]);
    const p = (
      await pools.root.query(
        `insert into hdk_published (article_id, article_number, locale, version_id, audience, title, doc, body_text, slug, original_locale)
         values ($1, $2, 'ru', $3, $4, 'Решение', $5, 'Текст', 'reshenie', 'ru') returning published_id`,
        [a.article_id, a.number, v, audience, doc],
      )
    ).rows[0].published_id;
    await pools.root.query(
      `insert into hdk_search_documents (published_id, ref_id, kind, article_type, locale, title, body_text, audience) values ($1, $2, 'article', 'solution', 'ru', 'Решение', 'Текст', $3)`,
      [p, a.article_id, audience],
    );
    if (audience === 'clients') {
      await pools.root.query(`insert into hdk_article_sources (org_id, article_id, ticket_id) values ($1, $2, $3)`, [f.orgA.orgId, a.article_id, f.tickets.aOrg.ticketId]);
      await pools.root.query(`insert into hdk_article_files (article_id, storage_key, file_name, mime, size) values ($1, 'kb/1', 'a.png', 'image/png', 10)`, [a.article_id]);
      const sig = (await pools.root.query(`insert into hdk_error_signatures (article_id, signature) values ($1, repeat('a', 32)) returning signature_id`, [a.article_id])).rows[0].signature_id;
      await pools.root.query(`insert into hdk_signature_orgs (org_id, signature_id) values ($1, $2)`, [f.orgA.orgId, sig]);
    }
  }
  await pools.root.query(`insert into hdk_deflection_events (org_id, user_id, session_id, query_hash) values ($1, $2, uuidv7(), repeat('f', 64))`, [f.orgA.orgId, f.aUser.userId]);
  // Запрос подсказки без результата (план W6, решение 17): без пользователя и организации.
  await pools.root.query(`insert into hdk_suggest_misses (session_id, locale, query_text) values (uuidv7(), 'ru', 'отчёт не открывается')`);
  // Журнал вызовов модели (веха M5, задача 5): вызов по обращению организации A, без текста.
  await pools.root.query(`insert into hda_runs (org_id, purpose, model, outcome) values ($1, 'solution_draft', 'stub-model', 'ok')`, [f.orgA.orgId]);
  // Отключение помощника пределом расходов (веха M5b, задача 1).
  await pools.root.query(`insert into hda_org_cutoffs (org_id, month, reason) values ($1, date_trunc('month', now())::date, 'budget_share')`, [f.orgA.orgId]);
  // Предложение разбора по обращению организации A и отключённое поле разбора (веха M5b, задача 7).
  const triageRun = (await pools.root.query(`insert into hda_runs (org_id, purpose, model, outcome, ticket_id) values ($1, 'first_line', 'stub-model', 'ok', $2) returning run_id`, [f.orgA.orgId, f.tickets.aOrg.ticketId])).rows[0].run_id;
  await pools.root.query(`insert into hda_triage_suggestions (org_id, ticket_id, run_id, field, value) values ($1, $2, $3, 'summary', 'Резюме для сотрудника')`, [f.orgA.orgId, f.tickets.aOrg.ticketId, triageRun]);
  const seedMessage = (await pools.root.query(`select message_id from hdt_ticket_messages where ticket_id = $1 order by created_on limit 1`, [f.tickets.aOrg.ticketId])).rows[0].message_id;
  // Машинный перевод сообщения клиента для сотрудника (веха M5b, задача 9).
  await pools.root.query(`insert into hda_message_translations (org_id, ticket_id, message_id, locale, status, text, requested_by) values ($1, $2, $3, 'ru', 'ready', 'Отчёт не открывается', $4)`, [f.orgA.orgId, f.tickets.aOrg.ticketId, seedMessage, f.l1.userId]);
  await pools.root.query(`insert into hda_triage_field_offs (field, month, share, decisions) values ('module', date_trunc('month', now())::date, 0.5, 40)`);
  // Кандидат в решение и его источник (веха M5c, задача 9): только сотрудникам, клиенту ни одной строки.
  const candidate = (await pools.root.query(`insert into hda_solution_candidates (locale, title, problem, source_count, org_count) values ('ru', 'Кандидат: накладная', 'Текст', 1, 1) returning candidate_id`)).rows[0].candidate_id;
  await pools.root.query(`insert into hda_candidate_sources (org_id, candidate_id, ticket_id) values ($1, $2, $3)`, [f.orgA.orgId, candidate, f.tickets.aOrg.ticketId]);
  // Идеи (веха M7, задача 1): опубликованная идея организации Б, идея Б на модерации и своя идея А на модерации; голоса,
  // подписки, комментарии (опубликованный, чужой на проверке и свой на проверке), отборы (завершённый и открытый),
  // вложения (чистое и непроверенное у опубликованной идеи Б). Клиент А должен видеть опубликованное Б и своё.
  const idea = async (orgId: string, author: { userId: string; name: string }, status: string) =>
    (
      await pools.root.query(
        `insert into hdi_ideas (org_id, author_id, author_name, original_locale, status, published_on)
         values ($1, $2, $3, 'ru', $4, case when $4 = 'pending_review' then null else now() end) returning idea_id`,
        [orgId, author.userId, author.name, status],
      )
    ).rows[0].idea_id as string;
  const bOpen = await idea(f.orgB.orgId, f.bUser, 'open');
  const bPending = await idea(f.orgB.orgId, f.bUser, 'pending_review');
  const aPending = await idea(f.orgA.orgId, f.aUser, 'pending_review');
  for (const id of [bOpen, bPending, aPending])
    await pools.root.query(`insert into hdi_idea_translations (idea_id, locale, title, body, source_hash) values ($1, 'ru', 'Идея', 'Описание', repeat('a', 64))`, [id]);
  await pools.root.query(
    `insert into hdi_idea_translations (idea_id, locale, title, body, is_machine, status, source_hash) values ($1, 'en', 'Idea', 'Text', true, 'rejected', repeat('a', 64))`,
    [bOpen],
  );
  await pools.root.query(`insert into hdi_votes (org_id, idea_id, user_id) values ($1, $3, $2), ($4, $3, $5)`, [f.orgA.orgId, f.aUser.userId, bOpen, f.orgB.orgId, f.bUser.userId]);
  await pools.root.query(`insert into hdi_subscriptions (idea_id, user_id) values ($1, $2), ($1, $3)`, [bOpen, f.aUser.userId, f.bUser.userId]);
  await pools.root.query(
    `insert into hdi_comments (org_id, idea_id, author_id, author_name, body, status) values ($1, $2, $3, 'Тимур', 'Поддерживаю', 'published'),
       ($1, $2, $3, 'Тимур', 'Звоните +998 90 123 45 67', 'pending'), ($4, $2, $5, 'Алишер', 'Мой на проверке', 'pending')`,
    [f.orgB.orgId, bOpen, f.bUser.userId, f.orgA.orgId, f.aUser.userId],
  );
  await pools.root.query(
    `insert into hdi_cycles (cycle, vote_mode, status, shortlist, leader_idea_id, selected_idea_id, decided_on)
     values ('2026-10-01', 'per_user', 'decided', $2, $1, $1, now()), ('2026-11-01', 'per_user', 'open', '[]', null, null, null)`,
    [bOpen, JSON.stringify([{ ideaId: bOpen, number: 1, voteCount: 2, orgCount: 2, place: 1 }])],
  );
  for (const [status, key] of [
    ['clean', 'files/ideas/b/1'],
    ['pending', 'quarantine/ideas/b/2'],
  ])
    await pools.root.query(
      `insert into hdi_attachments (org_id, idea_id, uploader_id, storage_key, file_name, mime, size, scan_status) values ($1, $2, $3, $4, 'idea.png', 'image/png', 10, $5)`,
      [f.orgB.orgId, bOpen, f.bUser.userId, key, status],
    );
  await pools.root.query(`insert into hdi_attachments (org_id, uploader_id, storage_key, file_name, mime, size) values ($1, $2, 'quarantine/ideas/a/3', 'mine.png', 'image/png', 10)`, [
    f.orgA.orgId,
    f.aUser.userId,
  ]);
  // Известные проблемы (веха M5c, задача 1): показанная с текстом сотрудника, принятым и непринятым машинными
  // переводами; скрытая; закрытая. Клиент через представление должен видеть только показанную и только принятые тексты.
  const problem = async (title: string, shown: boolean) =>
    (await pools.root.query(`insert into hdp_problems (internal_title, show_to_clients) values ($1, $2) returning problem_id`, [title, shown])).rows[0].problem_id as string;
  const shownProblem = await problem('Накладные ACME не проводятся', true);
  const hiddenProblem = await problem('Скрытая проблема', false);
  const closedProblem = await problem('Закрытая проблема', true);
  await pools.root.query(`update hdp_problems set status = 'closed' where problem_id = $1`, [closedProblem]);
  await pools.root.query(
    `insert into hdp_problem_translations (problem_id, locale, public_title, public_body, is_machine, accepted_by, accepted_on)
     values ($1, 'ru', 'Не проводятся накладные', 'Исправляем', false, null, null),
            ($1, 'en', 'Invoices are not posted', 'Fixing', true, $4, now()),
            ($1, 'uz', 'Nakladnoylar o''tmayapti', 'Tuzatyapmiz', true, null, null),
            ($2, 'ru', 'Скрытая', 'Текст', false, null, null),
            ($3, 'ru', 'Закрытая', 'Текст', false, null, null)`,
    [shownProblem, hiddenProblem, closedProblem, f.adminStaff.userId],
  );
  await pools.root.query(`insert into hdp_problem_signatures (problem_id, signature) values ($1, repeat('b', 32)), ($2, repeat('c', 32))`, [shownProblem, hiddenProblem]);
  // Черновик проблемы с предложенным обращением (веха M8b, решение 20): клиент не видит ни черновика, ни предложений.
  const draftProblem = (await pools.root.query(`insert into hdp_problems (internal_title, status) values ('Черновик AI-сотрудника', 'draft') returning problem_id`)).rows[0].problem_id as string;
  await pools.root.query(`insert into hdp_problem_proposals (problem_id, ticket_id, org_id) values ($1, $2, $3)`, [draftProblem, f.tickets.aOrg.ticketId, f.orgA.orgId]);
  // Всплеск сигнатуры (веха M8b, задача 8): счётчик без организаций, клиент его не видит.
  const spike = (await pools.root.query(`insert into hda_signature_spikes (signature, org_count, ticket_count, window_minutes) values (repeat('b', 32), 3, 4, 60) returning spike_id`)).rows[0].spike_id as string;
  // Событие для AI-сотрудника (веха M8b, задача 9): только система.
  await pools.root.query(`insert into hda_agent_events (kind, spike_id, body) values ('signature_spike', $1, '{"kind": "signature_spike"}')`, [spike]);
  // Объявления (веха M5c, задача 6): действующее для всех (текст сотрудника и непринятый машинный перевод), для чужого
  // сервера и ещё не начавшееся; закрытие баннера клиентом А.
  const otherServer = (
    await pools.root.query(`insert into hdu_servers (name, base_url, issuer, oauth_client_id, oauth_client_secret, code) values ('Другой', 'https://other-seed.smartup.example', 'https://other-seed.smartup.example', 'hub', $1, 'other-seed') returning server_id`, [SEALED])
  ).rows[0].server_id;
  const announcement = async (audience: string, serverId: string | null, startsIn: string) =>
    (
      await pools.root.query(
        `insert into hdp_announcements (server_id, author_id, kind, audience, source_locale, starts_on, ends_on)
         values ($1, $2, 'maintenance', $3, 'ru', now() + $4::interval, now() + $4::interval + interval '2 days') returning announcement_id`,
        [serverId, f.care.userId, audience, startsIn],
      )
    ).rows[0].announcement_id as string;
  const forAll = await announcement('all', null, '-1 hour');
  const foreign = await announcement('server', otherServer, '-1 hour');
  const later = await announcement('all', null, '1 day');
  await pools.root.query(
    `insert into hdp_announcement_translations (announcement_id, locale, title, body, is_machine) values ($1, 'ru', 'Работы', 'Ночью', false), ($1, 'en', 'Works', 'At night', true), ($2, 'ru', 'Чужой сервер', 'Текст', false), ($3, 'ru', 'Позже', 'Текст', false)`,
    [forAll, foreign, later],
  );
  await pools.root.query(`insert into hdp_announcement_dismissals (user_id, announcement_id) values ($1, $2)`, [f.aUser.userId, forAll]);
  // Рассылка по показанной проблеме (веха M5c, задача 5).
  await pools.root.query(`insert into hdp_broadcasts (problem_id, author_id, kind, source_locale, body) values ($1, $2, 'update', 'ru', '{"ru": "Исправляем"}')`, [shownProblem, f.adminStaff.userId]);
  // AI-сотрудник (веха M8b, задача 1): учётная запись agent_bot, основной токен, строка журнала вызовов и сводка.
  const bot = (await pools.root.query(`insert into auth."user" (name, email, "emailVerified") values ('AI-сотрудник: Hermes', $1, false) returning id`, [`agent-bot-seed-${Date.now()}-${Math.random()}@users.invalid`])).rows[0].id;
  await pools.root.query(`insert into hdu_staff (user_id, role) values ($1, 'agent_bot')`, [bot]);
  const agentToken = (
    await pools.root.query(
      `insert into hda_agent_tokens (name, staff_user_id, token_hash, token_last4, tools, allowed_ips, expires_at)
       values ('Hermes: поддержка', $1, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'abcd', '{search_tickets,create_report}', '{10.0.3.12/32}', now() + interval '30 days') returning token_id`,
      [bot],
    )
  ).rows[0].token_id;
  await pools.root.query(`insert into hda_agent_tool_calls (token_id, tool, args_digest, status, duration_ms) values ($1, 'search_tickets', repeat('a', 64), 'ok', 5)`, [agentToken]);
  await pools.root.query(`insert into hda_agent_reports (kind, title, body, token_id) values ('morning', 'Утренняя сводка', 'Текст', $1)`, [agentToken]);
  // Знания из кода (веха M8c, задача 1): сканирование, утверждённая запись с шаблоном, заметка о модуле, запрос анализа
  // по обращению организации A. Клиент не видит ни одной строки, первая линия только "что проверить".
  const codeSuffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const codeScan = (
    await pools.root.query(`insert into hda_code_scans (token_id, scan_key, repository, commit_ref) values ($1, $2, 'smartup-core', 'abc1234') returning scan_id`, [agentToken, `seed-${codeSuffix}`])
  ).rows[0].scan_id as string;
  const codeEntry = (
    await pools.root.query(
      `insert into hda_code_error_entries (scan_id, approved_by, key, code, repository, conditions, user_cause, what_to_check, kind, confidence, status, scan_digest, approved_on)
       values ($1, $2, $3, 'ORA-20001', 'smartup-core', 'Условия', 'Причина', '["Остаток"]', 'user_error', 0.8, 'approved', repeat('a', 64), now()) returning entry_id`,
      [codeScan, f.adminStaff.userId, `seed.entry_${codeSuffix}`],
    )
  ).rows[0].entry_id as string;
  await pools.root.query(`insert into hda_code_error_templates (entry_id, locale, template) values ($1, 'ru', $2)`, [codeEntry, `Сид ${codeSuffix}: нет товара {product}`]);
  await pools.root.query(`insert into hda_code_module_notes (scan_id, module_code, repository, name, scan_digest) values ($1, $2, 'smartup-core', '{"ru": "Заказы"}', repeat('b', 64))`, [codeScan, `seed_${codeSuffix}`]);
  await pools.root.query(`insert into hda_code_analysis_requests (org_id, ticket_id, requested_by, source, due_on) values ($1, $2, $3, 'staff', now() + interval '10 minutes')`, [
    f.orgA.orgId,
    f.tickets.aOrg.ticketId,
    f.adminStaff.userId,
  ]);
  // Актор этого токена: представления агента (задача 2) отдают строки только ему.
  const agent: AgentActor = { type: 'agent', tokenId: agentToken, userId: bot, tools: ['search_tickets', 'create_report'], ticketId: null };
  return { ...f, agent };
}
