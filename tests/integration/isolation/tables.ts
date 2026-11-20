// Набор проверок изоляции (ТЗ, раздел 15.2): перечень таблиц и представлений предметной области.
//
// Каждая новая таблица или представление схемы public получает здесь строку: что видит клиент
// под ролью hub_app. Тест registry.test.ts падает, если в базе есть объект без строки
// или строка без объекта, и проверяет каждое значение запросом напрямую в базу.
//
//   none     клиент не видит ни одной строки (или не имеет права на таблицу);
//   own-org  клиент видит только строки своей организации;
//   all      справочник: строки одинаковы для всех организаций;
//   own-user клиент видит только строки, где user_id его собственный.

export type ClientAccess = 'none' | 'own-org' | 'all' | 'own-user';

export const DOMAIN_OBJECTS: Record<string, { client: ClientAccess }> = {
  // Ядро
  hdc_audit_log: { client: 'none' },
  hdc_rate_limits: { client: 'none' },
  hdc_settings: { client: 'none' },
  // Уведомления
  hdn_telegram_updates: { client: 'none' },
  // Справочники
  hdr_product_modules: { client: 'all' },
  // Идентичность
  hdu_contact_identities: { client: 'own-user' },
  hdu_email_tokens: { client: 'none' },
  hdu_invitations: { client: 'own-org' },
  hdu_link_codes: { client: 'none' },
  hdu_login_codes: { client: 'none' },
  hdu_memberships: { client: 'own-org' },
  hdu_organizations: { client: 'own-org' },
  hdu_servers: { client: 'none' },
  hdu_staff: { client: 'none' },
  hdu_user_profiles: { client: 'own-org' },
};
