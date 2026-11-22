// Набор проверок изоляции (ТЗ, раздел 15.2): перечень таблиц и представлений предметной области.
//
// Каждая новая таблица или представление схемы public получает здесь строку. Тест registry.test.ts
// падает, если в базе есть объект без строки или строка без объекта, и проверяет каждое значение
// запросом напрямую в базу.
//
// client: что видит клиент под ролью hub_app.
//   none        клиент не видит ни одной строки (или не имеет права на таблицу);
//   own-org     клиент видит только строки своей организации, и хотя бы одну видит;
//   org-people  клиент видит только людей своей организации и сотрудников портала;
//   all         справочник: строки одинаковы для всех организаций;
//   own-user    клиент видит только строки, где user_id его собственный, и хотя бы одну видит.
//
// app, auth: какие изменения разрешены ролям hub_app и hub_auth. Тест сверяет с правами в базе,
// а остальные проверки берут отсюда, что должно быть закрыто (проверка main, Q2).

export type ClientAccess = 'none' | 'own-org' | 'org-people' | 'all' | 'own-user';
export type Write = 'insert' | 'update' | 'delete';
export type DomainObject = { client: ClientAccess; app?: Write[]; auth?: Write[] };

const IU: Write[] = ['insert', 'update'];
const IUD: Write[] = ['insert', 'update', 'delete'];

export const DOMAIN_OBJECTS: Record<string, DomainObject> = {
  // Ядро. Журнал аудита только пополняется (решение 0019).
  hdc_audit_log: { client: 'none', app: ['insert'], auth: ['insert'] },
  hdc_rate_limits: { client: 'none', app: IUD },
  hdc_settings: { client: 'none', app: IUD },
  // Уведомления
  // Очередь исходящих (веха M4): ставит действие, отправляет система, клиент не видит.
  hdn_outbox: { client: 'none', app: IU },
  hdn_telegram_updates: { client: 'none', app: ['insert', 'delete'] },
  // Справочники
  hdr_business_calendars: { client: 'all', app: IU },
  hdr_l1_playbooks: { client: 'none', app: IUD },
  hdr_product_modules: { client: 'all', app: IUD },
  hdr_reply_templates: { client: 'none', app: IU },
  hdr_sla_policies: { client: 'all', app: IU },
  // Идентичность: меняет только hub_auth, удаляет только отвязка контакта.
  hdu_contact_identities: { client: 'own-user', auth: IUD },
  // Ссылки и коды удаляет только ночная очистка системой (решение 0023, дополнение M2).
  hdu_email_tokens: { client: 'none', auth: IUD },
  hdu_invitations: { client: 'own-org', auth: IU },
  hdu_link_codes: { client: 'none', auth: IUD },
  hdu_login_codes: { client: 'none', auth: IUD },
  hdu_memberships: { client: 'own-org', auth: IU },
  hdu_organizations: { client: 'own-org', auth: IU },
  hdu_server_checks: { client: 'none', auth: IU },
  hdu_servers: { client: 'none', auth: IU },
  hdu_staff: { client: 'none', auth: IU },
  hdu_user_profiles: { client: 'org-people' },
  // Обращения (веха M2): клиент читает свою организацию, личные обращения коллег видит только администратор
  // клиента (это проверяет tickets-direct.test.ts). Удалить обращение, сообщение и событие не может никто.
  hdt_mentions: { client: 'none', app: IU },
  hdt_reply_drafts: { client: 'none', app: IUD },
  hdt_saved_filters: { client: 'none', app: IUD },
  hdt_tickets: { client: 'own-org', app: IU },
  hdt_ticket_line_transfers: { client: 'none', app: IU },
  hdt_ticket_presence: { client: 'none', app: IUD },
  hdt_ticket_reads: { client: 'none', app: IU },
  hdt_ticket_messages: { client: 'own-org', app: ['insert'] },
  hdt_ticket_events: { client: 'own-org', app: ['insert'] },
  hdt_ticket_watchers: { client: 'own-user', app: ['insert', 'delete'] },
  hdt_attachments: { client: 'own-org', app: IUD },
};
