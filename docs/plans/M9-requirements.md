# Перечень требований раздела 7 (ТЗ 15.5, пункт 1)

Дата: 27.11.2026. План: `docs/plans/M9.md`, задача 1, решение 21. Для каждого кода FR разделов 7.1-7.22 ТЗ версии 1.2: состояние, доказательство и, где нужно, чего ждёт или по какому решению перенесено. Полноту перечня и ссылки сверяет проверка `fr-coverage` в `pnpm check` (`scripts/checks/fr-coverage.mjs`).

Состояния:

- **сделано**: требование работает в среде разработки, доказательство: тест в `tests/`;
- **сделано на заглушке**: код и тест есть, вместо внешнего сервиса работает ложный сервер или заглушка; в последнем столбце сказано, чего ждёт проверка с настоящим сервисом;
- **перенесено**: требование сделано не целиком или не сделано, в последнем столбце решение и куда перенесено.

Доказательство выбрано так: тест, где код требования назван прямо; если код в тестах не назван, тест той области, которая требование проверяет (например, `tests/integration/lines.test.ts` для линий). Источник состояний: отчёты вех `docs/plans/M0-report.md`-`M8c-report.md`, `W0-report.md`-`W6-report.md` и `M9-prep-report.md`.

Итог: 281 код; сделано 182, сделано на заглушке 98, перенесено 1 (частично).

### 7.1 Вход и организации

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-ID-01 | сделано на заглушке | `tests/e2e/client-login.spec.ts`, `tests/unit/checks/fr-coverage.test.ts` | Ложный сервер OIDC; ждёт регистрации портала на серверах Smartup (15.5 п. 10) |
| FR-ID-02 | сделано | `tests/integration/servers.test.ts` |  |
| FR-ID-03 | сделано | `tests/integration/sso-flow.test.ts` |  |
| FR-ID-04 | сделано на заглушке | `tests/integration/sso-flow.test.ts`, `tests/integration/provision.test.ts` | Ложный сервер OIDC; ждёт регистрации портала на серверах Smartup (15.5 п. 10) |
| FR-ID-05 | сделано | `tests/e2e/acceptance.spec.ts`, `tests/e2e/client-shell.spec.ts` |  |
| FR-ID-06 | сделано | `tests/integration/login-link.test.ts`, `tests/e2e/login-link.spec.ts` |  |
| FR-ID-07 | сделано | `tests/integration/email.test.ts`, `tests/integration/sso-flow.test.ts` |  |
| FR-ID-08 | сделано | `tests/integration/invitations.test.ts`, `tests/e2e/invitations.spec.ts` |  |
| FR-ID-09 | сделано | `tests/e2e/staff-login.spec.ts` |  |
| FR-ID-10 | сделано | `tests/e2e/portal-access.spec.ts` |  |
| FR-ID-11 | сделано | `tests/integration/sessions.test.ts`, `tests/e2e/sessions.spec.ts` |  |
| FR-ID-12 | сделано | `tests/integration/cli.test.ts` |  |
| FR-ID-13 | сделано на заглушке | `tests/integration/invitations.test.ts`, `tests/integration/members.test.ts` | Ложный сервер OIDC; ждёт регистрации портала на серверах Smartup (15.5 п. 10) |
| FR-ID-14 | сделано на заглушке | `tests/integration/telegram-link.test.ts`, `tests/integration/telegram-login.test.ts` | Ложный сервер Telegram; ждёт @SmartupSupportBot |

### 7.2 Обращения: сторона клиента

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-TK-01 | сделано | `tests/integration/tickets-create.test.ts`, `tests/e2e/ideas-submit.spec.ts` |  |
| FR-TK-02 | сделано | `tests/integration/tickets-create.test.ts` |  |
| FR-TK-03 | сделано | `tests/integration/isolation/tickets-direct.test.ts` |  |
| FR-TK-04 | сделано | `tests/integration/tickets-create.test.ts` |  |
| FR-TK-05 | сделано | `tests/integration/tickets-create.test.ts` |  |
| FR-TK-06 | сделано | `tests/integration/tickets-read.test.ts` |  |
| FR-TK-07 | сделано | `tests/integration/tickets-read.test.ts` |  |
| FR-TK-08 | сделано | `tests/integration/tickets-actions.test.ts` |  |
| FR-TK-09 | сделано | `tests/integration/tickets-actions.test.ts` |  |
| FR-TK-10 | сделано | `tests/integration/housekeeping.test.ts` |  |
| FR-TK-11 | сделано | `tests/integration/csat-link.test.ts`, `tests/integration/isolation/tickets-writes.test.ts` |  |
| FR-TK-12 | сделано | `tests/integration/tickets-actions.test.ts` |  |
| FR-TK-13 | сделано | `tests/integration/attachments-download.test.ts`, `tests/integration/uploads.test.ts` |  |
| FR-TK-14 | сделано | `tests/integration/hda-message-ai.test.ts`, `tests/integration/housekeeping.test.ts` |  |
| FR-TK-15 | сделано | `tests/integration/housekeeping.test.ts`, `tests/integration/ticket-notify.test.ts` |  |
| FR-TK-16 | сделано | `tests/e2e/tickets.spec.ts`, `tests/unit/drafts.test.ts` |  |
| FR-TK-17 | сделано | `tests/integration/tickets-read.test.ts`, `tests/e2e/tickets.spec.ts` |  |
| FR-TK-18 | сделано | `tests/integration/hdt-ai-feedback.test.ts`, `tests/e2e/ai-first-line.spec.ts` |  |

### 7.3 Рабочее место агента

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-AG-01 | сделано | `tests/integration/agent-queues.test.ts` |  |
| FR-AG-02 | сделано | `tests/integration/agent-actions.test.ts` |  |
| FR-AG-03 | сделано | `tests/integration/agent-messages.test.ts` |  |
| FR-AG-04 | сделано | `tests/integration/agent-ticket.test.ts` |  |
| FR-AG-05 | сделано | `tests/integration/agent-ticket.test.ts`, `tests/integration/hdk-suggest.test.ts` |  |
| FR-AG-06 | сделано | `tests/integration/templates.test.ts`, `tests/unit/template-picker.test.ts` |  |
| FR-AG-07 | сделано | `tests/integration/merge.test.ts` |  |
| FR-AG-08 | сделано | `tests/integration/staff-create.test.ts` |  |
| FR-AG-09 | сделано | `tests/integration/agent-actions.test.ts` |  |
| FR-AG-10 | сделано | `tests/integration/search-staff.test.ts` |  |
| FR-AG-11 | сделано | `tests/integration/hda-message-ai.test.ts`, `tests/e2e/ai-first-line.spec.ts` |  |
| FR-AG-12 | сделано | `tests/integration/macros.test.ts`, `tests/integration/stale-actions.test.ts` |  |
| FR-AG-13 | сделано | `tests/integration/snooze-returned.test.ts`, `tests/e2e/agent.spec.ts` |  |
| FR-AG-14 | сделано | `tests/integration/agent-queues.test.ts` |  |
| FR-AG-15 | сделано | `tests/integration/macros.test.ts`, `tests/e2e/macros.spec.ts` |  |
| FR-AG-16 | сделано | `tests/integration/staff-notify.test.ts` |  |
| FR-AG-17 | сделано | `tests/integration/agent-queues.test.ts`, `tests/e2e/agent.spec.ts` |  |
| FR-AG-18 | сделано | `tests/integration/agent-queues.test.ts` |  |
| FR-AG-19 | сделано | `tests/integration/hda-review.test.ts`, `tests/e2e/ai-first-line.spec.ts` |  |
| FR-AG-20 | сделано | `tests/integration/hdp-links.test.ts`, `tests/integration/merge.test.ts` |  |
| FR-AG-21 | сделано | `tests/unit/drafts.test.ts`, `tests/integration/agent-messages.test.ts` |  |
| FR-AG-22 | сделано | `tests/integration/tags.test.ts`, `tests/e2e/tags.spec.ts` |  |
| FR-AG-23 | сделано | `tests/integration/unidentified.test.ts` |  |

### 7.4 SLA

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-SLA-01 | сделано | `tests/integration/sla-config.test.ts` |  |
| FR-SLA-02 | сделано | `tests/integration/ticket-sla.test.ts` |  |
| FR-SLA-03 | сделано | `tests/integration/agent-actions.test.ts`, `tests/integration/ticket-sla.test.ts` |  |
| FR-SLA-04 | сделано | `tests/integration/agent-messages.test.ts`, `tests/integration/hdt-ai-state.test.ts` |  |
| FR-SLA-05 | сделано | `tests/integration/ticket-sla.test.ts` |  |
| FR-SLA-06 | сделано | `tests/integration/staff-notify.test.ts`, `tests/unit/sla-badge.test.tsx` |  |
| FR-SLA-07 | сделано | `tests/unit/hdn-oncall.test.ts` |  |
| FR-SLA-08 | сделано | `tests/integration/ticket-sla.test.ts`, `tests/e2e/tickets.spec.ts` |  |
| FR-SLA-09 | сделано | `tests/integration/housekeeping.test.ts`, `tests/integration/ticket-notify.test.ts` |  |
| FR-SLA-10 | сделано | `tests/integration/hda-review.test.ts` |  |
| FR-SLA-11 | сделано | `tests/integration/hdt-ai-state.test.ts` |  |
| FR-SLA-12 | сделано | `tests/integration/sla-config.test.ts` |  |

### 7.5 Решения и подсказка

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-SOL-01 | сделано | `tests/integration/hdk-publish.test.ts` |  |
| FR-SOL-02 | сделано | `tests/integration/hdk-draft.test.ts`, `tests/integration/hdk-publish.test.ts` |  |
| FR-SOL-03 | сделано на заглушке | `tests/integration/hdk-draft.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-SOL-04 | сделано | `tests/integration/hda-candidate-actions.test.ts`, `tests/integration/hda-code-ticket.test.ts` |  |
| FR-SOL-05 | сделано | `tests/integration/hdk-publish.test.ts` |  |
| FR-SOL-06 | сделано на заглушке | `tests/integration/hdk-translations.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-SOL-07 | сделано | `tests/integration/hdk-signatures.test.ts`, `tests/unit/hdk-signature.test.ts` |  |
| FR-SOL-08 | сделано | `tests/integration/hdk-suggest.test.ts`, `tests/e2e/solutions-suggest.spec.ts` |  |
| FR-SOL-09 | сделано | `tests/integration/hdk-suggest.test.ts`, `tests/unit/hdk-ranking.test.ts` |  |
| FR-SOL-10 | сделано | `tests/unit/hdk-ranking.test.ts` |  |
| FR-SOL-11 | сделано | `tests/e2e/solutions-suggest.spec.ts` |  |
| FR-SOL-12 | сделано | `tests/integration/hdk-suggest.test.ts` |  |
| FR-SOL-13 | сделано | `tests/integration/hdk-suggest.test.ts`, `tests/integration/hdk-metrics.test.ts` |  |
| FR-SOL-14 | сделано | `tests/perf/pilot-p95.test.ts`, `tests/perf/suggest-p95.test.ts` |  |
| FR-SOL-15 | сделано | `tests/integration/embed-widget.test.ts` |  |
| FR-SOL-16 | сделано | `tests/unit/hdk-doc-schema.test.ts` |  |
| FR-SOL-17 | сделано | `tests/integration/hdk-tables.test.ts` |  |
| FR-SOL-18 | сделано | `tests/integration/hdk-translations.test.ts` |  |
| FR-SOL-19 | сделано | `tests/integration/ai-metrics.test.ts`, `tests/integration/hdk-metrics.test.ts` |  |

### 7.6 Виджет

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-WG-01 | сделано на заглушке | `tests/e2e/widget-report.spec.ts`, `tests/unit/widget-loader.test.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-02 | сделано на заглушке | `tests/e2e/widget-host.spec.ts`, `tests/unit/widget-loader.test.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-03 | сделано на заглушке | `tests/integration/embed-widget.test.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-04 | сделано на заглушке | `tests/integration/embed-session.test.ts`, `tests/integration/widget-mode-b.test.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-05 | сделано на заглушке | `tests/integration/embed-session.test.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-06 | сделано на заглушке | `tests/integration/embed-tickets.test.ts`, `tests/e2e/widget-tickets.spec.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-07 | сделано на заглушке | `tests/e2e/widget-report.spec.ts`, `tests/unit/widget-loader.test.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-08 | сделано на заглушке | `tests/e2e/widget-mobile.spec.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-09 | сделано на заглушке | `tests/integration/widget-registry.test.ts`, `tests/e2e/security-headers.spec.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |
| FR-WG-10 | сделано на заглушке | `tests/unit/widget-loader.test.ts` | Страница хозяина на ложном сервере; ждёт тестовой сборки Smartup Web (15.5 п. 11) |

### 7.7 Биржа идей

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-IDEA-01 | сделано | `tests/integration/hdi-submit.test.ts`, `tests/e2e/ideas-submit.spec.ts` |  |
| FR-IDEA-02 | сделано | `tests/integration/hdi-similar.test.ts` |  |
| FR-IDEA-03 | сделано | `tests/integration/hdi-moderate.test.ts`, `tests/e2e/agent-ideas.spec.ts` |  |
| FR-IDEA-04 | сделано | `tests/integration/hdi-board.test.ts`, `tests/e2e/ideas-board.spec.ts` |  |
| FR-IDEA-05 | сделано | `tests/integration/hdi-vote-tabs.test.ts` |  |
| FR-IDEA-06 | сделано | `tests/integration/hdi-board.test.ts` |  |
| FR-IDEA-07 | сделано | `tests/integration/hdi-comments.test.ts` |  |
| FR-IDEA-08 | сделано | `tests/integration/hdi-moderate.test.ts`, `tests/integration/hdi-development.test.ts` |  |
| FR-IDEA-09 | сделано | `tests/integration/hdi-cycles.test.ts` |  |
| FR-IDEA-10 | сделано | `tests/integration/hdi-cycles.test.ts` |  |
| FR-IDEA-11 | сделано | `tests/integration/hdi-notices.test.ts` |  |
| FR-IDEA-12 | сделано | `tests/integration/hdi-development.test.ts` |  |
| FR-IDEA-13 | сделано | `tests/integration/hdi-submit.test.ts` |  |
| FR-IDEA-14 | сделано | `tests/integration/hdi-board.test.ts` |  |
| FR-IDEA-15 | сделано | `tests/integration/hdi-staff.test.ts` |  |
| FR-IDEA-16 | сделано | `tests/integration/hdi-cycles.test.ts` |  |

### 7.8 Уведомления и почта

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-NT-01 | сделано | `tests/integration/hdi-notices.test.ts`, `tests/integration/ticket-notify.test.ts` |  |
| FR-NT-02 | сделано | `tests/integration/notifications.test.ts`, `tests/unit/hdn-mail-render.test.ts` |  |
| FR-NT-03 | сделано | `tests/integration/notifications.test.ts`, `tests/e2e/notifications.spec.ts` |  |
| FR-NT-04 | сделано | `tests/integration/notification-channels.test.ts`, `tests/integration/notifications.test.ts` |  |
| FR-NT-05 | сделано | `tests/integration/email-reply.test.ts`, `tests/unit/hdn-email-text.test.ts` |  |
| FR-NT-06 | сделано | `tests/unit/hdn-reply-address.test.ts` |  |
| FR-NT-07 | сделано | `tests/integration/email-reply.test.ts` |  |
| FR-NT-08 | сделано | `tests/integration/email-files.test.ts` |  |
| FR-NT-09 | сделано | `tests/integration/outbox.test.ts`, `tests/integration/telegram-notify.test.ts` |  |
| FR-NT-10 | сделано | `tests/integration/ticket-notify.test.ts` |  |
| FR-NT-11 | сделано | `tests/integration/hdt-ai-link.test.ts`, `tests/unit/hdn-telegram-text.test.ts` |  |
| FR-NT-12 | сделано | `tests/integration/hdp-broadcasts.test.ts` |  |
| FR-NT-13 | сделано на заглушке | `tests/integration/telegram-link.test.ts`, `tests/e2e/telegram-notify.spec.ts` | Ложный сервер Telegram; ждёт @SmartupSupportBot |
| FR-NT-14 | сделано на заглушке | `tests/integration/hdp-broadcasts.test.ts`, `tests/integration/notification-channels.test.ts` | Ложный сервер Telegram; ждёт @SmartupSupportBot |
| FR-NT-15 | сделано на заглушке | `tests/integration/telegram-notify.test.ts`, `tests/unit/hdn-telegram-text.test.ts` | Ложный сервер Telegram; ждёт @SmartupSupportBot |
| FR-NT-16 | сделано на заглушке | `tests/integration/telegram-webhook.test.ts` | Ложный сервер Telegram; ждёт @SmartupSupportBot |

### 7.9 Передача в разработку

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-DEV-01 | сделано на заглушке | `tests/integration/dev-tasks.test.ts`, `tests/unit/hdw/dev-tracker.test.ts` | Ручной режим и заготовка API с контрактными тестами; ждёт API таск-менеджера Smartup |
| FR-DEV-02 | сделано на заглушке | `tests/e2e/dev-tasks.spec.ts` | Ручной режим и заготовка API с контрактными тестами; ждёт API таск-менеджера Smartup |
| FR-DEV-03 | сделано на заглушке | `tests/integration/dev-tracker-contract.test.ts`, `tests/unit/hdw/smartup-tracker.test.ts` | Ручной режим и заготовка API с контрактными тестами; ждёт API таск-менеджера Smartup |
| FR-DEV-04 | сделано на заглушке | `tests/unit/hdw/tracker-sign.test.ts` | Ручной режим и заготовка API с контрактными тестами; ждёт API таск-менеджера Smartup |
| FR-DEV-05 | сделано на заглушке | `tests/integration/dev-tasks.test.ts`, `tests/e2e/dev-tasks.spec.ts` | Ручной режим и заготовка API с контрактными тестами; ждёт API таск-менеджера Smartup |
| FR-DEV-06 | сделано на заглушке | `tests/integration/dev-tasks.test.ts`, `tests/integration/hdi-development.test.ts` | Ручной режим и заготовка API с контрактными тестами; ждёт API таск-менеджера Smartup |

### 7.10 Администрирование

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-ADM-01 | сделано | `tests/integration/servers.test.ts`, `tests/integration/widget-registry.test.ts` |  |
| FR-ADM-02 | сделано | `tests/integration/members.test.ts`, `tests/e2e/organizations.spec.ts` |  |
| FR-ADM-03 | сделано | `tests/integration/staff-admin.test.ts`, `tests/e2e/settings-staff.spec.ts` |  |
| FR-ADM-04 | сделано | `tests/integration/catalog-settings.test.ts` |  |
| FR-ADM-05 | сделано | `tests/integration/sla-config.test.ts` |  |
| FR-ADM-06 | сделано | `tests/integration/templates.test.ts` |  |
| FR-ADM-07 | сделано | `tests/integration/audit.test.ts`, `tests/e2e/settings-audit.spec.ts` |  |
| FR-ADM-08 | сделано | `tests/integration/mail-settings.test.ts`, `tests/e2e/mail-settings.spec.ts` |  |
| FR-ADM-09 | сделано | `tests/integration/hda-limits.test.ts`, `tests/e2e/ai-settings.spec.ts` |  |
| FR-ADM-10 | сделано | `tests/integration/macros.test.ts`, `tests/integration/rules-admin.test.ts` |  |
| FR-ADM-11 | сделано | `tests/integration/webhooks.test.ts`, `tests/e2e/webhooks.spec.ts` |  |
| FR-ADM-12 | сделано | `tests/integration/hdp-announcements.test.ts`, `tests/integration/hdp-problems.test.ts` |  |
| FR-ADM-13 | сделано | `tests/integration/hda-agent-tokens.test.ts`, `tests/e2e/agent-tokens.spec.ts` |  |
| FR-ADM-14 | сделано | `tests/integration/mail-settings.test.ts` |  |
| FR-ADM-15 | сделано | `tests/integration/hda-code-queue.test.ts`, `tests/e2e/code-knowledge.spec.ts` |  |

### 7.11 Языки

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|

### 7.12 Метрики

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-MET-01 | сделано | `tests/integration/metrics.test.ts`, `tests/e2e/metrics.spec.ts` |  |
| FR-MET-02 | сделано | `tests/integration/hdk-metrics.test.ts` |  |
| FR-MET-03 | сделано | `tests/integration/widget-mode-b.test.ts` |  |
| FR-MET-04 | сделано | `tests/integration/metrics.test.ts`, `tests/e2e/metrics.spec.ts` |  |
| FR-MET-05 | сделано | `tests/integration/hdk-metrics.test.ts` |  |
| FR-MET-06 | сделано | `tests/integration/ai-metrics.test.ts`, `tests/e2e/metrics.spec.ts` |  |
| FR-MET-07 | сделано | `tests/integration/metrics.test.ts` |  |
| FR-MET-08 | сделано | `tests/integration/problems-metrics.test.ts` |  |
| FR-MET-09 | сделано | `tests/integration/problems-metrics.test.ts` |  |
| FR-MET-10 | сделано | `tests/integration/widget-mode-b.test.ts`, `tests/e2e/metrics.spec.ts` |  |
| FR-MET-11 | сделано | `tests/integration/ai-metrics.test.ts` |  |

### 7.13 AI-помощник первой линии

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-AI-01 | сделано на заглушке | `tests/integration/hda-first-line.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-02 | сделано на заглушке | `tests/integration/hda-first-line.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-03 | сделано на заглушке | `tests/integration/hda-first-line.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-04 | сделано на заглушке | `tests/integration/hda-first-line.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-05 | сделано на заглушке | `tests/integration/hda-first-line.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-06 | сделано на заглушке | `tests/unit/hda-language.test.ts`, `tests/unit/hda-topics.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-07 | сделано на заглушке | `tests/integration/hdt-ai-state.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-08 | сделано на заглушке | `tests/integration/hdt-ai-feedback.test.ts`, `tests/e2e/ai-first-line.spec.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-09 | сделано на заглушке | `tests/integration/hda-first-line.test.ts`, `tests/integration/hdt-ai-feedback.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-10 | сделано на заглушке | `tests/integration/hdt-ai-feedback.test.ts`, `tests/integration/hdt-ai-state.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-11 | сделано на заглушке | `tests/eval/ai.test.ts`, `tests/integration/hda-first-line.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-12 | сделано на заглушке | `tests/integration/hda-first-line.test.ts`, `tests/unit/hda-language.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-13 | сделано на заглушке | `tests/integration/hda-triage.test.ts`, `tests/e2e/ai-first-line.spec.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-14 | сделано на заглушке | `tests/integration/hda-first-line.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-15 | сделано на заглушке | `tests/integration/hda-first-line.test.ts`, `tests/integration/hdt-ai-state.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-16 | сделано на заглушке | `tests/integration/hda-review.test.ts`, `tests/e2e/ai-first-line.spec.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-17 | сделано на заглушке | `tests/integration/hda-limits.test.ts`, `tests/e2e/ai-settings.spec.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-18 | сделано на заглушке | `tests/integration/ai-metrics.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-19 | сделано на заглушке | `tests/e2e/ai-first-line.spec.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-20 | сделано на заглушке | `tests/unit/hda-assemble.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-AI-21 | сделано на заглушке | `tests/integration/hda-limits.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |

### 7.14 AI-разбор обращения

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-TRI-01 | сделано на заглушке | `tests/integration/hda-triage.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-TRI-02 | сделано на заглушке | `tests/e2e/ai-first-line.spec.ts`, `tests/unit/hda-triage-text.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-TRI-03 | сделано на заглушке | `tests/integration/hda-triage.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-TRI-04 | сделано на заглушке | `tests/integration/hda-triage.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-TRI-05 | сделано на заглушке | `tests/integration/hda-triage.test.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |
| FR-TRI-06 | сделано на заглушке | `tests/integration/hda-triage.test.ts`, `tests/e2e/ai-first-line.spec.ts` | Модель на заглушке; замер качества ждёт ключа Anthropic и 100 размеченных обращений (15.5 п. 13) |

### 7.15 Известные проблемы

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-KP-01 | сделано | `tests/integration/hdp-problems.test.ts`, `tests/e2e/agent-problems.spec.ts` |  |
| FR-KP-02 | сделано | `tests/integration/hdp-problems.test.ts` |  |
| FR-KP-03 | сделано | `tests/e2e/known-problem-s9.spec.ts` |  |
| FR-KP-04 | сделано | `tests/integration/hdp-links.test.ts` |  |
| FR-KP-05 | сделано | `tests/integration/hdp-client.test.ts`, `tests/e2e/known-problem-client.spec.ts` |  |
| FR-KP-06 | сделано | `tests/integration/hdp-broadcasts.test.ts` |  |
| FR-KP-07 | сделано | `tests/integration/hdp-broadcasts.test.ts` |  |
| FR-KP-08 | сделано | `tests/integration/hdp-client.test.ts` |  |
| FR-KP-09 | сделано | `tests/integration/hdp-client.test.ts`, `tests/e2e/known-problem-client.spec.ts` |  |
| FR-KP-10 | сделано | `tests/integration/problems-metrics.test.ts` |  |
| FR-KP-11 | сделано | `tests/integration/dev-tasks.test.ts` |  |
| FR-KP-12 | сделано | `tests/integration/hda-first-line.test.ts` |  |
| FR-KP-13 | сделано | `tests/integration/problems-metrics.test.ts` |  |

### 7.16 Кандидаты в решения

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-CAND-01 | сделано | `tests/integration/hda-candidates.test.ts` |  |
| FR-CAND-02 | сделано | `tests/unit/hda-candidate-merge.test.ts` |  |
| FR-CAND-03 | сделано | `tests/integration/hda-candidates.test.ts` |  |
| FR-CAND-04 | сделано | `tests/integration/hda-candidate-actions.test.ts`, `tests/e2e/candidates.spec.ts` |  |
| FR-CAND-05 | сделано | `tests/integration/hda-candidates.test.ts` |  |
| FR-CAND-06 | сделано | `tests/integration/hda-candidates.test.ts`, `tests/e2e/candidates.spec.ts` |  |
| FR-CAND-07 | сделано | `tests/integration/hda-candidate-actions.test.ts` |  |
| FR-CAND-08 | сделано | `tests/integration/problems-metrics.test.ts` |  |
| FR-CAND-09 | сделано | `tests/integration/hdk-untrusted-publish.test.ts`, `tests/unit/hdk-checks.test.ts` |  |

### 7.17 Правила автоматизации

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-AUTO-01 | сделано | `tests/integration/rules-admin.test.ts`, `tests/e2e/rules.spec.ts` |  |
| FR-AUTO-02 | сделано | `tests/integration/domain-events.test.ts` |  |
| FR-AUTO-03 | сделано | `tests/integration/hdp-links.test.ts`, `tests/unit/hdw/evaluate.test.ts` |  |
| FR-AUTO-04 | сделано | `tests/integration/rules-engine.test.ts`, `tests/unit/hdn-oncall.test.ts` |  |
| FR-AUTO-05 | сделано | `tests/integration/rules-admin.test.ts` |  |
| FR-AUTO-06 | сделано | `tests/integration/rules-engine.test.ts` |  |
| FR-AUTO-07 | сделано | `tests/integration/builtin-rules.test.ts` |  |
| FR-AUTO-08 | сделано | `tests/integration/rules-dry-run.test.ts` |  |
| FR-AUTO-09 | сделано | `tests/integration/hdp-links.test.ts` |  |
| FR-AUTO-10 | сделано | `tests/integration/rules-admin.test.ts`, `tests/integration/webhooks.test.ts` |  |
| FR-AUTO-11 | сделано | `tests/integration/rules-engine.test.ts` |  |
| FR-AUTO-12 | перенесено | `tests/integration/builtin-rules.test.ts`, `tests/e2e/builtin-rules.spec.ts` | Частично: уведомления поставляются правилами (тест в доказательстве); напоминание клиенту и автозакрытие остались в коде, решение `docs/decisions/0043-builtin-rules.md`, пункт 10; ждёт ответа владельца о сроке правил в рабочих днях |
| FR-AUTO-13 | сделано | `tests/integration/tags.test.ts`, `tests/e2e/tags.spec.ts` |  |

### 7.18 Объявления

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-ANN-01 | сделано | `tests/integration/hdp-announcements.test.ts`, `tests/e2e/announcements.spec.ts` |  |
| FR-ANN-02 | сделано | `tests/integration/hdp-announcements.test.ts`, `tests/e2e/announcements.spec.ts` |  |
| FR-ANN-03 | сделано | `tests/integration/hda-first-line.test.ts` |  |
| FR-ANN-04 | сделано | `tests/integration/hdp-announcements.test.ts`, `tests/e2e/announcements.spec.ts` |  |

### 7.19 Линии поддержки и движение обращения

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-LINE-01 | сделано | `tests/integration/lines.test.ts` |  |
| FR-LINE-02 | сделано | `tests/integration/ticket-sla.test.ts` |  |
| FR-LINE-03 | сделано | `tests/integration/lines.test.ts`, `tests/integration/merge.test.ts` |  |
| FR-LINE-04 | сделано | `tests/integration/lines.test.ts` |  |
| FR-LINE-05 | сделано | `tests/integration/lines.test.ts` |  |
| FR-LINE-06 | сделано | `tests/integration/lines.test.ts`, `tests/integration/pickup-setting.test.ts` |  |
| FR-LINE-07 | сделано | `tests/integration/agent-messages.test.ts` |  |
| FR-LINE-08 | сделано | `tests/integration/ai-metrics.test.ts`, `tests/integration/metrics.test.ts` |  |
| FR-LINE-09 | сделано | `tests/integration/merge.test.ts`, `tests/integration/email-reply.test.ts` |  |
| FR-LINE-10 | сделано | `tests/integration/lines.test.ts`, `tests/unit/lines.test.ts` |  |

### 7.20 Обращения по почте

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-EM-01 | сделано на заглушке | `tests/integration/email-new-ticket.test.ts`, `tests/unit/hdn-mail-render.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-02 | сделано на заглушке | `tests/integration/email-reply.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-03 | сделано на заглушке | `tests/integration/email-new-ticket.test.ts`, `tests/unit/hdn-auth-results.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-04 | сделано на заглушке | `tests/integration/unidentified.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-05 | сделано на заглушке | `tests/integration/email-new-ticket.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-06 | сделано на заглушке | `tests/integration/mail-settings.test.ts`, `tests/integration/unidentified.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-07 | сделано на заглушке | `tests/unit/hdn-classify.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-08 | сделано на заглушке | `tests/integration/email-reply.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-09 | сделано на заглушке | `tests/integration/email-new-ticket.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-10 | сделано на заглушке | `tests/integration/email-new-ticket.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-11 | сделано на заглушке | `tests/integration/email-new-ticket.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-12 | сделано на заглушке | `tests/integration/hdt-ai-link.test.ts`, `tests/unit/hdt-ai-link.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-13 | сделано на заглушке | `tests/integration/mail-settings.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-14 | сделано на заглушке | `tests/integration/mail-settings.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |
| FR-EM-15 | сделано на заглушке | `tests/unit/hdn-email-hidden.test.ts`, `tests/unit/hdn-email-text.test.ts` | Ложный сервис почты; ждёт Resend и DNS (15.5 пп. 7, 16) |

### 7.21 Подключение AI-агентов: сервер MCP и Hermes Agent

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-AGT-01 | сделано на заглушке | `tests/integration/hda-mcp-server.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-02 | сделано на заглушке | `tests/integration/hda-agent-tokens.test.ts`, `tests/e2e/agent-tokens.spec.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-03 | сделано на заглушке | `tests/integration/hda-agent-read-tools.test.ts`, `tests/unit/hda-agent-catalog.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-04 | сделано на заглушке | `tests/integration/hda-agent-write-tools.test.ts`, `tests/integration/hda-code-scan.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-05 | сделано на заглушке | `tests/unit/hda-agent-catalog.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-06 | сделано на заглушке | `tests/integration/hda-agent-views.test.ts`, `tests/unit/hda-agent-anonymize.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-07 | сделано на заглушке | `tests/e2e/agent-bot-marks.spec.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-08 | сделано на заглушке | `tests/integration/hda-agent-events.test.ts`, `tests/integration/hda-code-analysis.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-09 | сделано на заглушке | `tests/integration/hda-agent-tokens.test.ts`, `tests/integration/hda-mcp-server.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-10 | сделано на заглушке | `tests/integration/hda-agent-write-tools.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-11 | сделано на заглушке | `tests/integration/hda-signature-spikes.test.ts`, `tests/unit/hda-spike-rule.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-12 | сделано на заглушке | `tests/integration/hda-agent-run-token.test.ts`, `tests/integration/hda-agent-views.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-13 | сделано на заглушке | `tests/unit/hda-team-chat.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-14 | сделано на заглушке | `tests/integration/hda-agent-read-tools.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |
| FR-AGT-15 | сделано на заглушке | `tests/integration/hda-agent-read-tools.test.ts`, `tests/unit/hda-agent-anonymize.test.ts` | Тестовый клиент MCP; проверка с Hermes Agent ждёт его профиля (15.5 п. 17) |

### 7.22 Знание исходного кода

| Код | Состояние | Доказательство | Что ждёт или решение |
|---|---|---|---|
| FR-CODE-01 | сделано на заглушке | `tests/integration/hda-code-scan.test.ts`, `tests/unit/hda-code-report.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-02 | сделано на заглушке | `tests/integration/hda-code-access.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-03 | сделано на заглушке | `tests/integration/hda-code-queue.test.ts`, `tests/e2e/code-knowledge.spec.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-04 | сделано на заглушке | `tests/integration/hdk-code-signature.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-05 | сделано на заглушке | `tests/integration/hda-code-access.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-06 | сделано на заглушке | `tests/integration/hda-code-ticket.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-07 | сделано на заглушке | `tests/integration/hda-code-ticket.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-08 | сделано на заглушке | `tests/integration/hda-code-analysis.test.ts`, `tests/unit/hda-code-note.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-09 | сделано на заглушке | `tests/integration/rules-code-analysis.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-10 | сделано на заглушке | `tests/integration/hda-code-analysis.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-11 | сделано на заглушке | `tests/e2e/code-client-hidden.spec.ts`, `tests/unit/agent-nav.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-12 | сделано на заглушке | `tests/integration/hda-code-scan.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-13 | сделано на заглушке | `tests/integration/hda-code-scan.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-14 | сделано на заглушке | `tests/unit/hda-team-chat.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |
| FR-CODE-15 | сделано на заглушке | `tests/integration/hda-code-ticket.test.ts` | Отчёт-пример сканирования; настоящее сканирование ждёт доступа Hermes Agent к репозиториям |

## Что ждёт внешних сервисов и людей

| Заглушка | Требования | Чего ждёт | Пункт 15.5 |
|---|---|---|---|
| Модель Claude | FR-AI, FR-TRI, черновики и переводы от Claude (FR-SOL, FR-IDEA, FR-CAND, FR-KP) | Ключ Anthropic и 100 размеченных обращений | 13 |
| Ложный сервер OIDC | FR-ID-01, FR-ID-04, FR-ID-13 | Регистрация портала на общем облаке и выделенном сервере | 10 |
| Страница хозяина виджета | FR-WG | Тестовая сборка Smartup Web | 11 |
| Ложный сервис почты | FR-EM | Resend, DNS, переадресация адреса поддержки | 7, 16 |
| Ложный сервер Telegram | FR-ID-14, FR-NT-13..FR-NT-16 | @SmartupSupportBot | 16 |
| Тестовый клиент MCP | FR-AGT | Профиль Hermes Agent, ответ юриста на вопрос 40 | 17 |
| Отчёт-пример сканирования | FR-CODE | Доступ Hermes Agent к репозиториям Smartup | 17 |
| Заготовка API таск-менеджера | FR-DEV | API таск-менеджера Smartup (ручной режим работает) | - |

## Перенесено: для ответа владельца

Согласием владельца на перенос считается его ответ по отчёту вехи `docs/plans/M9-report.md`.

| № | Код | Что не сделано | Решение | Куда |
|---|---|---|---|---|
| 1 | FR-AUTO-12 | Напоминание клиенту и автозакрытие решённого и ждущего не стали предустановленными правилами: событие "нет активности" не выражает рабочие дни, точку отсчёта и однократность. Уведомления дежурным, руководителю линии и о низкой оценке поставляются правилами | `docs/decisions/0043-builtin-rules.md`, пункт 10 | Остаются в коде; правилами после ответа владельца, нужен ли правилам срок в рабочих днях |
