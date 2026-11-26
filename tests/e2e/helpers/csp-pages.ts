// Обход политики содержимого (план подготовки M9, задача 2, решение 2; ТЗ 14.4). Строка на каждую страницу
// (page.tsx) и каждый обработчик (route.ts) каталога src/app: маршрут как путь каталога, адрес для проверки и кто его
// открывает. Полноту списка сверяет pnpm check (scripts/checks/csp-pages.mjs): новая страница без строки не проходит.
// Значения в фигурных скобках подставляет tests/e2e/csp-all-pages.spec.ts из базы браузерных тестов; если строки
// нет, подставляется несуществующее значение, и проверяется страница "не найдено" того же маршрута (код 404).
// Файл без импортов: его читает и Node.js в проверке правил.

/** Кто открывает адрес: посетитель без входа, клиент ACME Trade или сотрудник с ролью admin. */
export type CspWho = 'guest' | 'client' | 'admin';

export type CspPage = {
  /** Путь каталога страницы от src/app, с группами маршрутов. */
  route: string;
  path: string;
  who: CspWho;
  /** Страница виджета с ключом сервера: frame-ancestors адресами сервера Smartup, а не 'none' (план M6, задача 3). */
  embedKey?: true;
  /** Страница входит в браузерный обход с ловушкой нарушений (по одной на группу маршрутов и больше). */
  walk?: true;
  /** Ожидаемый код ответа, если не 200: перенаправление или "не найдено" для этого человека. */
  status?: 307 | 404;
};

export type CspHandler = { route: string; path: string; who: CspWho };

const A = '[locale]/(agent)/agent';

export const CSP_PAGES: readonly CspPage[] = [
  // Рабочее место сотрудника.
  { route: `${A}`, path: '/ru/agent', who: 'admin', walk: true },
  { route: `${A}/account`, path: '/ru/agent/account', who: 'admin' },
  { route: `${A}/ideas`, path: '/ru/agent/ideas', who: 'admin', walk: true },
  { route: `${A}/ideas/[number]`, path: '/ru/agent/ideas/{idea}', who: 'admin', walk: true },
  { route: `${A}/ideas/cycles`, path: '/ru/agent/ideas/cycles', who: 'admin' },
  { route: `${A}/metrics`, path: '/ru/agent/metrics', who: 'admin', walk: true },
  { route: `${A}/notifications`, path: '/ru/agent/notifications', who: 'admin' },
  { route: `${A}/organizations`, path: '/ru/agent/organizations', who: 'admin' },
  { route: `${A}/organizations/[orgId]`, path: '/ru/agent/organizations/{org}', who: 'admin' },
  { route: `${A}/playbooks`, path: '/ru/agent/playbooks', who: 'admin' },
  { route: `${A}/queues`, path: '/ru/agent/queues?queue=all', who: 'admin', walk: true },
  { route: `${A}/queues/thanks`, path: '/ru/agent/queues/thanks', who: 'admin' },
  { route: `${A}/queues/unidentified`, path: '/ru/agent/queues/unidentified', who: 'admin' },
  { route: `${A}/settings`, path: '/ru/agent/settings', who: 'admin' },
  { route: `${A}/settings/audit`, path: '/ru/agent/settings/audit', who: 'admin' },
  { route: `${A}/settings/knowledge`, path: '/ru/agent/settings/knowledge', who: 'admin' },
  { route: `${A}/settings/macros`, path: '/ru/agent/settings/macros', who: 'admin' },
  { route: `${A}/settings/macros/[macroId]`, path: '/ru/agent/settings/macros/{macro}', who: 'admin' },
  { route: `${A}/settings/macros/new`, path: '/ru/agent/settings/macros/new', who: 'admin', walk: true },
  { route: `${A}/settings/mail`, path: '/ru/agent/settings/mail', who: 'admin' },
  { route: `${A}/settings/rules`, path: '/ru/agent/settings/rules', who: 'admin' },
  { route: `${A}/settings/rules/[ruleId]`, path: '/ru/agent/settings/rules/{rule}', who: 'admin', walk: true },
  { route: `${A}/settings/rules/new`, path: '/ru/agent/settings/rules/new', who: 'admin' },
  { route: `${A}/settings/servers`, path: '/ru/agent/settings/servers', who: 'admin' },
  { route: `${A}/settings/servers/[code]`, path: '/ru/agent/settings/servers/mock', who: 'admin', walk: true },
  { route: `${A}/settings/servers/new`, path: '/ru/agent/settings/servers/new', who: 'admin' },
  { route: `${A}/settings/sla`, path: '/ru/agent/settings/sla', who: 'admin' },
  { route: `${A}/settings/staff`, path: '/ru/agent/settings/staff', who: 'admin' },
  { route: `${A}/settings/tags`, path: '/ru/agent/settings/tags', who: 'admin' },
  { route: `${A}/settings/templates`, path: '/ru/agent/settings/templates', who: 'admin' },
  { route: `${A}/settings/webhooks`, path: '/ru/agent/settings/webhooks', who: 'admin' },
  { route: `${A}/settings/webhooks/[endpointId]`, path: '/ru/agent/settings/webhooks/{webhook}', who: 'admin' },
  { route: `${A}/settings/webhooks/new`, path: '/ru/agent/settings/webhooks/new', who: 'admin' },
  { route: `${A}/solutions`, path: '/ru/agent/solutions', who: 'admin' },
  { route: `${A}/solutions/[number]`, path: '/ru/agent/solutions/{solution}', who: 'admin', walk: true },
  { route: `${A}/solutions/[number]/preview`, path: '/ru/agent/solutions/{solution}/preview', who: 'admin', walk: true },
  { route: `${A}/solutions/new`, path: '/ru/agent/solutions/new', who: 'admin' },
  { route: `${A}/tickets/[number]`, path: '/ru/agent/tickets/{ticket}', who: 'admin', walk: true },
  { route: `${A}/tickets/new`, path: '/ru/agent/tickets/new', who: 'admin' },
  // Вход и одноразовые ссылки.
  { route: '[locale]/(auth)/confirm-email', path: '/ru/confirm-email', who: 'guest' },
  { route: '[locale]/(auth)/invite', path: '/ru/invite', who: 'guest' },
  { route: '[locale]/(auth)/login', path: '/ru/login', who: 'guest', walk: true },
  { route: '[locale]/(auth)/login/link', path: '/ru/login/link', who: 'guest' },
  { route: '[locale]/(auth)/login/tg', path: '/ru/login/tg', who: 'guest' },
  { route: '[locale]/(auth)/rate', path: '/ru/rate', who: 'guest' },
  { route: '[locale]/(auth)/staff/login', path: '/ru/staff/login', who: 'guest', walk: true },
  { route: '[locale]/(auth)/staff/setup', path: '/ru/staff/setup', who: 'guest' },
  // Витрина и пробный редактор (только при HUB_SHOWCASE=1).
  { route: '[locale]/(dev)/dev/editor', path: '/ru/dev/editor', who: 'admin', walk: true },
  { route: '[locale]/(dev)/dev/ui', path: '/en/dev/ui', who: 'admin', walk: true },
  // Виджет в Smartup Web и страница мобильного приложения (план M6).
  { route: '[locale]/(embed)/embed/report', path: '/ru/embed/report?key={embedKey}', who: 'guest', embedKey: true, walk: true },
  { route: '[locale]/(embed)/embed/tickets', path: '/uz/embed/tickets?key={embedKey}', who: 'guest', embedKey: true },
  { route: '[locale]/(embed)/embed/tickets/[number]', path: '/ru/embed/tickets/{clientTicket}?key={embedKey}', who: 'guest', embedKey: true },
  { route: '[locale]/(embed)/m/report', path: '/ru/m/report', who: 'guest', walk: true },
  // Шаги после входа клиента. Клиенту с одной организацией приветствие и выбор организации не нужны.
  { route: '[locale]/(gate)/no-organization', path: '/ru/no-organization', who: 'client', status: 307 },
  { route: '[locale]/(gate)/select-organization', path: '/ru/select-organization', who: 'client', walk: true },
  { route: '[locale]/(gate)/welcome', path: '/ru/welcome', who: 'client', status: 307 },
  // Кабинет клиента.
  { route: '[locale]/(portal)', path: '/ru', who: 'client', walk: true },
  { route: '[locale]/(portal)/help/a/[ref]', path: '/ru/help/a/{helpRef}', who: 'client', walk: true },
  { route: '[locale]/(portal)/ideas', path: '/ru/ideas', who: 'client', walk: true },
  { route: '[locale]/(portal)/ideas/[number]', path: '/ru/ideas/{idea}', who: 'client', walk: true },
  // Править можно только свою идею на модерации: чужая опубликованная не найдена.
  { route: '[locale]/(portal)/ideas/[number]/edit', path: '/ru/ideas/{idea}/edit', who: 'client', status: 404 },
  { route: '[locale]/(portal)/ideas/cycles', path: '/ru/ideas/cycles', who: 'client' },
  { route: '[locale]/(portal)/ideas/new', path: '/ru/ideas/new', who: 'client', walk: true },
  { route: '[locale]/(portal)/notifications', path: '/ru/notifications', who: 'client' },
  // Страница организации открыта только её администратору, а клиент тестов обычный участник.
  { route: '[locale]/(portal)/org', path: '/ru/org', who: 'client', status: 404 },
  { route: '[locale]/(portal)/settings', path: '/ru/settings', who: 'client' },
  { route: '[locale]/(portal)/tickets', path: '/uz/tickets', who: 'client', walk: true },
  { route: '[locale]/(portal)/tickets/[number]', path: '/ru/tickets/{clientTicket}', who: 'client', walk: true },
  { route: '[locale]/(portal)/tickets/new', path: '/ru/tickets/new', who: 'client', walk: true },
  // Открытая зона и неизвестный адрес.
  // Пока политика обработки данных не утверждена, страницы нет (tests/e2e/legal.spec.ts).
  { route: '[locale]/(public)/legal/privacy', path: '/ru/legal/privacy', who: 'guest', walk: true, status: 404 },
  { route: '[locale]/[...rest]', path: '/en/no-such-page', who: 'guest', walk: true, status: 404 },
];

const NO_ID = '00000000-0000-7000-8000-000000000000';

export const CSP_HANDLERS: readonly CspHandler[] = [
  { route: `${A}/ideas/[number]/files/[id]`, path: `/ru/agent/ideas/{idea}/files/${NO_ID}`, who: 'admin' },
  { route: `${A}/metrics/export`, path: '/ru/agent/metrics/export', who: 'admin' },
  { route: `${A}/solutions/[number]/files/[id]`, path: `/ru/agent/solutions/{solution}/files/${NO_ID}`, who: 'admin' },
  { route: '[locale]/(auth)/login/smartup', path: '/ru/login/smartup', who: 'guest' },
  { route: '[locale]/(dev)/dev/editor/sample-image', path: '/ru/dev/editor/sample-image', who: 'admin' },
  { route: '[locale]/(portal)/help/a/[ref]/files/[id]', path: `/ru/help/a/{helpRef}/files/${NO_ID}`, who: 'client' },
  { route: '[locale]/(portal)/ideas/[number]/files/[id]', path: `/ru/ideas/{idea}/files/${NO_ID}`, who: 'client' },
  // Код привязки Telegram создаётся только по переходу со страницы портала: без входа здесь перенаправление.
  { route: '[locale]/(portal)/settings/telegram', path: '/ru/settings/telegram', who: 'guest' },
  { route: 'api/attachments/[id]', path: `/api/attachments/${NO_ID}`, who: 'client' },
  { route: 'api/auth/[...all]', path: '/api/auth/get-session', who: 'guest' },
  { route: 'api/csp-report', path: '/api/csp-report', who: 'guest' },
  { route: 'api/embed/form', path: '/api/embed/form', who: 'guest' },
  { route: 'api/embed/session', path: '/api/embed/session', who: 'guest' },
  { route: 'api/embed/solutions/[ref]', path: '/api/embed/solutions/{helpRef}', who: 'guest' },
  { route: 'api/embed/tickets', path: '/api/embed/tickets', who: 'guest' },
  { route: 'api/embed/tickets/[number]', path: '/api/embed/tickets/{clientTicket}', who: 'guest' },
  { route: 'api/health', path: '/api/health', who: 'guest' },
  { route: 'api/ideas/similar', path: '/api/ideas/similar', who: 'client' },
  { route: 'api/ready', path: '/api/ready', who: 'guest' },
  { route: 'api/suggest', path: '/api/suggest', who: 'client' },
  { route: 'api/uploads/complete', path: '/api/uploads/complete', who: 'client' },
  { route: 'api/uploads/local', path: '/api/uploads/local', who: 'client' },
  { route: 'api/uploads/presign', path: '/api/uploads/presign', who: 'client' },
  { route: 'api/webhooks/email', path: '/api/webhooks/email', who: 'guest' },
  { route: 'api/webhooks/telegram', path: '/api/webhooks/telegram', who: 'guest' },
  { route: 'api/webhooks/tracker', path: '/api/webhooks/tracker', who: 'guest' },
];
