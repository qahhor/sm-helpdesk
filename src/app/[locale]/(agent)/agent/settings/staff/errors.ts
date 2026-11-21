// Коды ошибок раздела "Сотрудники", у которых есть текст (messages: agent.settings.staff.errors).
// Остальные показываются как invalid_input.
export const STAFF_PAGE_ERRORS: ReadonlySet<string> = new Set(['invalid_input', 'stale_session', 'forbidden', 'not_found', 'already_member', 'last_admin']);
