# Чек-лист OWASP ASVS 5.0.0, уровень 2

Дата: 26.11.2026. Основание: ТЗ 14.1 и 15.5 (приёмка по ASVS 5.0, уровень 2), план `docs/plans/M9-prep.md`, задача 1, решение 3. Заменяет частичный чек-лист `docs/security/asvs-m1.md` (вехи M0-M4), тот остаётся как история.

## Источник

Номера и уровни требований взяты из официального файла стандарта: репозиторий OWASP/ASVS, метка `v5.0.0`, файл `5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv` (sha256 `98c8fe911b9edb403af8ee05d3ce8201ecac2659e313b053890a62847cdcf680`), скачан 26.11.2026 с raw.githubusercontent.com. Выборка требований уровней 1 и 2 с английским текстом лежит рядом: `docs/security/asvs-5.0.0-l1-l2.csv` (253 требования из 345; уровня 3 в выборке нет). Текст стандарта распространяется по лицензии CC BY-SA 4.0, правообладатель OWASP Foundation. Формулировки в столбце "Требование" ниже краткие и свои, точный текст в выборке.

Тест `tests/unit/checks/asvs-links.test.ts` сверяет этот файл с выборкой: каждое требование ровно один раз, тот же уровень, состояние из списка, у выполненного доказательство, у невыполненного шаг, и каждый путь в столбце доказательств существует.

## Состояния

- **есть**: сделано и проверяется тестом или файлом в столбце доказательств;
- **частично**: сделана часть; что осталось и чьё это решение, в столбце "Что сделать";
- **нет**: не сделано; каждое такое требование названо в разделе "Отклонения" в конце;
- **не применимо**: в портале нет того, о чём требование (GraphQL, WebSocket, WebRTC, сервер авторизации OAuth).

"staging" в столбце "Что сделать" значит, что проверка возможна только на сервере (Cloudflare, TLS, сетевой экран, OWASP ZAP): шаг первой выкладки по памятке `docs/runbooks/launch.md`.

## Итог

Всего 253 требования: есть 161, не применимо 48, частично 43, нет 1.

Пробелы, исправленные в коде при подготовке M9 (каждый сначала тестом, который падал):

| Требование | Что было | Что сделано | Тест |
|---|---|---|---|
| 6.2.4 | 2472 из 3000 самых частых паролей от 12 знаков проходили проверку | Встроенный список 3000 частых паролей | `tests/unit/password-rules.test.ts` |
| 6.2.2, 6.2.3, 7.4.3 | Сотрудник не мог сменить пароль сам | Смена пароля на странице учётной записи: текущий и новый пароль, 5 попыток за 15 минут, все сессии завершаются, запись аудита | `tests/integration/staff-password-change.test.ts`, `tests/e2e/asvs-fixes.spec.ts` |
| 3.3.1, 3.3.3 | Куки языка и темы без приставки `__Host-` | На https имена `__Host-hub_locale`, `__Host-hub_theme` | `tests/unit/pref-cookies.test.ts` |
| 13.4.4 | TRACE доходил до Next.js и получал 500 | Caddy отвечает 405 на TRACE и TRACK | `tests/unit/compose-prod.test.ts` |
| 3.4.5 | Caddy затирал `Referrer-Policy: no-referrer` страниц виджета (проверено на Caddy 2.10.2) | Значение Caddy только для ответа без своего | `tests/unit/compose-prod.test.ts` |
| 14.3.1 | После выхода черновики обращений оставались в localStorage | Выход убирает записи портала из хранилищ браузера | `tests/unit/drafts.test.ts`, `tests/e2e/asvs-fixes.spec.ts` |
| 16.3.2 | Отказ в разделе рабочего места не попадал в журнал | Событие `authz.denied` без имени и адреса | `tests/integration/authz-denied.test.ts` |
| 3.4.2, 3.4.3, 14.3.2 | CSP и заголовки проверялись на части страниц | Обход всех страниц и обработчиков (задача 2) | `tests/e2e/csp-all-pages.spec.ts`, `tests/unit/checks/csp-pages.test.ts` |
| 13.4.5, 16.3.4 | Падение фонового процесса снаружи не видно | `/api/ready/worker`, сигнал `backup_stale` (задача 3) | `tests/integration/worker-heartbeat.test.ts`, `tests/integration/ops-watch-backup.test.ts` |

Как поддерживать: новая функция, которая меняет вход, сессии, файлы, заголовки или внешние связи, меняет строку этого файла в той же ветке. Новая версия стандарта: заменить выборку `docs/security/asvs-5.0.0-l1-l2.csv` и пройти строки заново.


## V1. Кодирование и очистка

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V1.1.1 | 2 | Ввод декодируется один раз и до проверки | есть | Адрес раскодирует прокси один раз, испорченный адрес идёт на 404: `src/proxy.ts`, `tests/e2e/security-headers.spec.ts`; данные форм и JSON проверяет Zod после разбора фреймворком: `src/modules/hdt/input.ts` |  |
| V1.1.2 | 2 | Кодирование вывода последним шагом или самим интерпретатором | есть | Разметку экранирует React, SQL параметризует Drizzle, письма собирает `src/modules/hdn/mail/render.ts`: `tests/unit/hdn-mail-render.test.ts`, `tests/unit/markdown.test.tsx` |  |
| V1.2.1 | 1 | Кодирование вывода по контексту HTML, атрибутов, заголовков | есть | React без вставки разметки (правило `inner-html` в `scripts/checks/forbidden-apis.mjs`), имя файла в Content-Disposition: `src/modules/hdc/storage/index.ts`; `tests/unit/untrusted-text.test.tsx`, `tests/unit/checks/forbidden-apis.test.ts` |  |
| V1.2.2 | 1 | Адреса из данных кодируются, протоколы javascript: и data: запрещены | есть | `tests/unit/markdown.test.tsx`, `tests/unit/hdk-doc-schema.test.ts`, `tests/unit/hdu-util.test.ts` (адрес возврата только внутри портала), `tests/unit/hdn-mail-render.test.ts` |  |
| V1.2.3 | 1 | Кодирование при сборке JavaScript и JSON | есть | JSON только через `JSON.stringify` и `Response.json`; единственный встроенный скрипт постоянный: `src/ui/theme/ThemeScript.tsx`; CSP без unsafe-inline: `tests/e2e/csp-all-pages.spec.ts` |  |
| V1.2.4 | 1 | Запросы к базе только параметризованные | есть | Правило `raw-sql` в `scripts/checks/forbidden-apis.mjs`, `tests/unit/checks/forbidden-apis.test.ts`, `tests/integration/sql-injection.test.ts`, `docs/decisions/0033-injection-and-brute-force.md` |  |
| V1.2.5 | 1 | Защита от внедрения команд ОС | есть | Код портала не вызывает команд ОС (в `src` нет `child_process`); консоль `hub` разбирает ключи `parseArgs` без оболочки: `src/cli/commands.ts`; сценарии копий берут значения в кавычках: `scripts/ops/backup.sh` |  |
| V1.2.6 | 2 | Внедрение в LDAP | не применимо | LDAP не используется |  |
| V1.2.7 | 2 | Внедрение в XPath | не применимо | XPath не используется |  |
| V1.2.8 | 2 | Обработчики LaTeX | не применимо | LaTeX не используется |  |
| V1.2.9 | 2 | Спецзнаки экранируются в регулярных выражениях | есть | Текст в регулярном выражении экранируется: `src/modules/hda/util.ts`; шаблоны LIKE экранирует правило `like-pattern` в `scripts/checks/forbidden-apis.mjs`, `tests/unit/checks/forbidden-apis.test.ts` |  |
| V1.3.1 | 1 | HTML из визуального редактора очищается | есть | Редактор решений хранит документ ProseMirror по строгой схеме, HTML не принимается: `src/modules/hdk/doc-schema.ts`, `tests/unit/hdk-doc-schema.test.ts`, `tests/unit/doc-view.test.tsx` |  |
| V1.3.2 | 1 | Нет eval и динамического выполнения кода | есть | CSP без unsafe-eval в production: `tests/e2e/csp-all-pages.spec.ts`, `tests/unit/csp.test.ts` |  |
| V1.3.3 | 2 | Данные для опасного контекста очищаются и ограничены по длине | есть | Схемы Zod с пределами длины, вырезание невидимых знаков: `tests/unit/clean-user-text.test.ts`, `tests/unit/hdt-input.test.ts`, `tests/unit/hdu-input.test.ts` |  |
| V1.3.4 | 2 | SVG пользователя проверяется или отклоняется | есть | SVG и HTML как вложения не принимаются под любым именем: `tests/unit/filetype.test.ts`, `docs/decisions/0027-file-storage-and-uploads.md` |  |
| V1.3.5 | 2 | Markdown, CSS и подобная разметка пользователя очищается | есть | Markdown без HTML, картинки заменяются подписью: `tests/unit/markdown.test.tsx`, `docs/decisions/0026-client-tickets.md` |  |
| V1.3.6 | 2 | Защита от SSRF списком протоколов и адресов | есть | Только https, внутренние адреса закрыты в момент соединения, без переадресаций: `src/security/outbound.ts`, `tests/unit/outbound.test.ts`, `tests/unit/url-safety.test.ts` |  |
| V1.3.7 | 2 | Шаблоны не строятся из недоверенного ввода | есть | Тексты из `messages/ru.json`, письма из шаблонов кода, в макросах только переменные из списка: `tests/unit/hdw/macro-schema.test.ts`, `tests/unit/hdn-mail-render.test.ts` |  |
| V1.3.8 | 2 | Внедрение в JNDI | не применимо | JNDI не используется (не Java) |  |
| V1.3.9 | 2 | Внедрение в memcache | не применимо | memcache не используется |  |
| V1.3.10 | 2 | Строки формата очищаются | есть | Строки ICU берутся только из репозитория, данные пользователя идут аргументами; проверка ICU в `scripts/checks/messages.mjs`, `tests/unit/checks/messages.test.ts` |  |
| V1.3.11 | 2 | Защита от внедрения в SMTP и IMAP | есть | Письма уходят через API Resend, заголовки собирает код; тема очищается: `tests/unit/hdn-email-provider.test.ts`, `tests/unit/hdn-mailer.test.ts` |  |
| V1.4.1 | 2 | Безопасная работа с памятью и строками | не применимо | TypeScript в Node.js: память управляется средой, ручной работы с указателями нет |  |
| V1.4.2 | 2 | Защита от переполнения целых | есть | Числа из ввода проверяются диапазоном схемы Zod, номера и размеры в `bigint` базы: `src/modules/hdt/input.ts`, `tests/unit/hdt-input.test.ts` |  |
| V1.4.3 | 2 | Освобождение памяти, висячие указатели | не применимо | Сборщик мусора Node.js |  |
| V1.5.1 | 1 | Безопасная настройка XML-разборщиков (XXE) | не применимо | XML не разбирается; HTML писем разбирает parse5 без внешних сущностей: `src/modules/hdn/inbound/email-text.ts` |  |
| V1.5.2 | 2 | Безопасная десериализация | есть | Только `JSON.parse` и строгие схемы; данные фоновых задач проверяются `z.object().strict()`: `src/worker/main.ts`, `tests/integration/worker.test.ts` |  |

## V2. Проверка данных и бизнес-логика

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V2.1.1 | 1 | Документ задаёт правила проверки ввода | есть | Поля и пределы в `docs/TZ.md` (разделы 7, 10.2, 14.3), схемы модулей `src/modules/hdu/input.ts`, `src/modules/hdt/input.ts` |  |
| V2.1.2 | 2 | Документ задаёт согласованность связанных данных | частично | Правила переходов и связок по функциям в `docs/TZ.md` и решениях, например `docs/decisions/0026-client-tickets.md`, `docs/decisions/0043-builtin-rules.md` | Сводного документа нет: правила разбросаны по ТЗ и решениям. Свести при приёмке M9 или принять ТЗ как этот документ (владелец) |
| V2.1.3 | 2 | Документ задаёт пределы бизнес-логики на пользователя и на портал | есть | `docs/TZ.md`, раздел 14.5; `docs/decisions/0033-injection-and-brute-force.md` |  |
| V2.2.1 | 1 | Проверка ввода по списку разрешённого | есть | Строгие схемы Zod с перечислениями: `tests/unit/hdu-input.test.ts`, `tests/unit/hdt-input.test.ts`, `tests/unit/hdw/rule-schema.test.ts` |  |
| V2.2.2 | 1 | Проверка на доверенном сервере, а не в браузере | есть | Каждое серверное действие и обработчик проверяет данные схемой (правило `CLAUDE.md`), база держит ограничения: `tests/integration/tickets-create.test.ts`, `tests/integration/isolation/tickets-writes.test.ts` |  |
| V2.2.3 | 2 | Сочетания связанных данных разумны | есть | `tests/unit/hdt-transitions.test.ts`, `tests/unit/hdw/rule-schema.test.ts`, `tests/unit/hdr/holidays-input.test.ts` |  |
| V2.3.1 | 1 | Шаги процесса идут по порядку без пропусков | есть | Вход сотрудника: пароль, затем код; сессия без кода годится только для подключения фактора: `tests/integration/staff.test.ts`; первый вход клиента: `tests/integration/sso-flow.test.ts` |  |
| V2.3.2 | 2 | Пределы бизнес-логики выполняются | есть | `tests/integration/rate-limit.test.ts`, `tests/integration/brute-force.test.ts`, `tests/unit/hdc-util.test.ts` (пределы раздела 14.5) |  |
| V2.3.3 | 2 | Операция целиком в транзакции | есть | Действие и запись аудита в одной транзакции `withActor`: `src/db/with-actor.ts`, `tests/integration/audit.test.ts`, `tests/integration/stale-actions.test.ts` |  |
| V2.3.4 | 2 | Блокировка ограниченных ресурсов от двойного использования | есть | Голос один на пользователя, пересчёт под блокировкой строки идеи, одноразовые ссылки под `FOR UPDATE`: `tests/integration/isolation/ideas-counters.test.ts`, `tests/integration/login-link.test.ts` |  |
| V2.4.1 | 2 | Защита от автоматизации и чрезмерных вызовов | есть | Пределы частоты в базе и проверка "не робот": `tests/integration/rate-limit.test.ts`, `tests/unit/bot-check.test.ts`, `docs/decisions/0018-external-services-in-m1.md` | Второй слой: правила Cloudflare на staging |

## V3. Безопасность веб-интерфейса

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V3.2.1 | 1 | Ответ не показывается браузером в чужом контексте | есть | Вложения только `Content-Disposition: attachment` и `nosniff`, GET с изменением только по своему переходу (`Sec-Fetch-*`): `tests/integration/attachments-download.test.ts`, `tests/unit/own-navigation.test.ts`, `tests/e2e/csp-all-pages.spec.ts` |  |
| V3.2.2 | 1 | Текст выводится как текст, а не разметка | есть | `tests/unit/untrusted-text.test.tsx`, `tests/unit/markdown.test.tsx`, правило `inner-html` в `scripts/checks/forbidden-apis.mjs` |  |
| V3.3.1 | 1 | Куки с Secure и приставкой __Host- или __Secure- | есть | Куки входа: `docs/decisions/0021-host-cookie-prefix.md`, `tests/integration/auth-instance.test.ts`. Куки языка и темы на https с `__Host-` (исправлено при подготовке M9): `tests/unit/pref-cookies.test.ts`, `src/i18n/locales.ts`, `src/ui/theme/theme.ts` |  |
| V3.3.2 | 2 | SameSite по назначению куки | есть | Сессия `SameSite=Lax`: возврат с сервера Smartup приходит переходом с чужого сайта; изменяющие запросы дополнительно проверяют Origin: `tests/unit/session-cookie.test.ts`, `tests/integration/auth-instance.test.ts` |  |
| V3.3.3 | 2 | Приставка __Host- у кук, не общих с другими узлами | есть | Как 3.3.1: `tests/integration/auth-instance.test.ts`, `tests/unit/pref-cookies.test.ts` |  |
| V3.3.4 | 2 | HttpOnly у кук, недоступных скриптам | есть | Куки входа и языка `HttpOnly`: `tests/integration/auth-instance.test.ts`, `src/i18n/actions.ts`. Кука темы читается скриптом темы намеренно и секрета не несёт: `src/ui/theme/theme.ts` |  |
| V3.4.1 | 1 | HSTS на всех ответах, от года, с поддоменами | частично | Caddy ставит `max-age=31536000; includeSubDomains` на каждый ответ: `Caddyfile`, `tests/unit/compose-prod.test.ts` | staging: проверить при первой выкладке (памятка запуска): заголовок за Cloudflare, Full strict |
| V3.4.2 | 1 | CORS только фиксированным значением или по списку | есть | Портал не ставит заголовков CORS ни на одном адресе: `tests/e2e/csp-all-pages.spec.ts` |  |
| V3.4.3 | 2 | CSP с object-src и base-uri none, одноразовым кодом | есть | `src/security/csp.ts`, `tests/unit/csp.test.ts`, `tests/e2e/csp-all-pages.spec.ts` (каждая страница и обработчик), `tests/unit/checks/csp-pages.test.ts`, `docs/decisions/0066-observability-and-csp-coverage.md` |  |
| V3.4.4 | 2 | nosniff на всех ответах | есть | `tests/e2e/csp-all-pages.spec.ts`, `tests/e2e/security-headers.spec.ts` |  |
| V3.4.5 | 2 | Referrer-Policy против утечки адресов | есть | Страницы `strict-origin-when-cross-origin`, виджет `no-referrer`; Caddy больше не затирает значение портала (исправлено при подготовке M9): `tests/unit/compose-prod.test.ts`, `tests/e2e/security-headers.spec.ts` | Повторить проверку за Cloudflare на staging |
| V3.4.6 | 2 | frame-ancestors на каждом ответе, встраивание только где нужно | есть | `tests/e2e/csp-all-pages.spec.ts`, `tests/e2e/security-headers.spec.ts`, `docs/decisions/0059-widget-loader-and-pages.md` |  |
| V3.5.1 | 1 | Межсайтовые запросы к важным функциям проверяются | есть | Серверные действия Next.js сверяют Origin с адресом портала; обработчики с сессией требуют JSON с того же Origin: `src/modules/hdc/util.ts`, `tests/unit/hdc-util.test.ts`; вебхуки подписаны: `tests/integration/email-webhook.test.ts` |  |
| V3.5.2 | 1 | Опора на предварительный запрос CORS не обходится простым запросом | есть | Нужен `Content-Type: application/json` и Origin портала: `tests/unit/hdc-util.test.ts` |  |
| V3.5.3 | 1 | Важные функции не на безопасных методах GET | есть | GET не меняет предметных данных; код привязки Telegram только по своему переходу: `tests/unit/own-navigation.test.ts`, `tests/e2e/w1-reads.spec.ts`, `docs/decisions/0038-capacity-and-hardening.md` |  |
| V3.5.4 | 2 | Разные приложения на разных узлах | есть | Портал на своём домене, виджет во фрейме Smartup Web другого узла: `docs/decisions/0059-widget-loader-and-pages.md` |  |
| V3.5.5 | 2 | postMessage: чужой источник и неверный вид отбрасываются | есть | `tests/unit/widget-protocol.test.ts`, `tests/unit/widget-loader.test.ts`, `src/ui/widget/protocol.ts` |  |
| V3.7.1 | 2 | Только поддерживаемые клиентские технологии | есть | Без плагинов, `object-src 'none'`: `src/security/csp.ts` |  |
| V3.7.2 | 2 | Переадресация на чужой узел только по списку | есть | Возврат после входа только относительный путь портала: `tests/unit/hdu-util.test.ts`; вход только через серверы реестра: `tests/integration/sso-flow.test.ts` |  |

## V4. API и веб-сервисы

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V4.1.1 | 1 | Content-Type с кодировкой у каждого ответа с телом | есть | Страницы `text/html; charset=utf-8`, выгрузка `text/csv; charset=utf-8`: `src/app/[locale]/(agent)/agent/metrics/export/route.ts`; JSON и problem+json без charset (RFC 8259 его не определяет): `src/modules/hdc/util.ts` |  |
| V4.1.2 | 2 | С http на https перенаправляются только страницы для людей | частично | Caddy и Cloudflare перенаправляют все адреса, включая `/api`: `Caddyfile` | Владелец: принять отклонение или на staging отключить перенаправление для `/api/` и вебхуков (их адреса задаются с https) |
| V4.1.3 | 2 | Заголовки промежуточного узла не подменяются пользователем | есть | Caddy отвечает только адресам Cloudflare, адрес посетителя из `cf-connecting-ip`; прокси портала затирает `x-nonce`, `x-hub-path`: `tests/unit/compose-prod.test.ts`, `tests/unit/hdc-util.test.ts`, `tests/e2e/security-headers.spec.ts`, `docs/decisions/0020-client-ip-source.md` |  |
| V4.2.1 | 2 | Защита от подмены границ запросов (request smuggling) | частично | Перед порталом Cloudflare и Caddy 2.10 с HTTP/1.1 и HTTP/2: `Caddyfile` | staging: проверить при первой выкладке (памятка запуска): скан OWASP ZAP |
| V4.3.1 | 2 | Пределы сложности GraphQL | не применимо | GraphQL нет |  |
| V4.3.2 | 2 | Интроспекция GraphQL выключена | не применимо | GraphQL нет |  |
| V4.4.1 | 1 | WebSocket только через WSS | не применимо | WebSocket не используется: присутствие и уведомления опросом |  |
| V4.4.2 | 2 | Проверка Origin при открытии WebSocket | не применимо | WebSocket не используется |  |
| V4.4.3 | 2 | Отдельные токены сессии WebSocket | не применимо | WebSocket не используется |  |
| V4.4.4 | 2 | Токены WebSocket через вошедшую сессию HTTPS | не применимо | WebSocket не используется |  |

## V5. Файлы

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V5.1.1 | 2 | Документ задаёт типы, расширения и размеры файлов | есть | `docs/decisions/0027-file-storage-and-uploads.md`, `docs/TZ.md` (раздел 14.3, "Файлы") |  |
| V5.2.1 | 1 | Принимаются только файлы посильного размера | есть | Предел 25 МБ (видео 50), 10 файлов, подпись ссылки фиксирует размер; тело запроса в Caddy 2 МБ: `tests/integration/uploads.test.ts`, `tests/unit/storage-r2.test.ts`, `Caddyfile` |  |
| V5.2.2 | 1 | Расширение и содержимое (магические байты) совпадают | есть | `tests/unit/filetype.test.ts`, `src/modules/hdc/filetype.ts` |  |
| V5.2.3 | 2 | Архивы проверяются по размеру и числу файлов до распаковки | есть | Портал архивы не распаковывает; ClamAV проверяет их с пределами размера и числа файлов, сверх пределов файл отклоняется: `tests/unit/compose-prod.test.ts` |  |
| V5.3.1 | 1 | Загруженное не выполняется на сервере | есть | Файлы лежат в R2 или локальном хранилище вне кода и отдаются ссылкой на скачивание: `tests/unit/storage-local.test.ts`, `tests/unit/storage-r2.test.ts` |  |
| V5.3.2 | 1 | Пути файлов из своих данных, без имени пользователя | есть | Ключ хранилища генерирует портал, знаки пути запрещены: `tests/unit/storage-local.test.ts`, `docs/decisions/0027-file-storage-and-uploads.md` |  |
| V5.4.1 | 2 | Имя пользователя проверяется, имя в Content-Disposition задаёт портал | есть | `tests/integration/attachments-download.test.ts`, `src/modules/hdc/storage/index.ts` |  |
| V5.4.2 | 2 | Имена файлов в ответах кодируются (RFC 6266) | есть | `contentDisposition` в `src/modules/hdc/storage/index.ts`, `tests/unit/storage-r2.test.ts` |  |
| V5.4.3 | 2 | Файлы из недоверенных источников проверяет антивирус | есть | Карантин до проверки ClamAV, отдаётся только чистый файл: `tests/unit/clamav.test.ts`, `tests/integration/attachment-scan.test.ts`, `tests/integration/email-files.test.ts` | Проверка с настоящим ClamAV на staging |

## V6. Аутентификация

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V6.1.1 | 1 | Документ: пределы частоты и защита от подбора и блокировки чужой учётной записи | есть | `docs/TZ.md` (раздел 14.5), `docs/decisions/0033-injection-and-brute-force.md` |  |
| V6.1.2 | 2 | Документ: список слов портала, запрещённых в паролях | есть | Список в начале `src/modules/hdu/password-rules.ts` (smartup, hub, helpdesk, greenwhite, имена и другие), `docs/decisions/0038-capacity-and-hardening.md` |  |
| V6.1.3 | 2 | Документ: все способы входа и их сила | есть | `docs/TZ.md` (раздел 11.2, FR-ID-05, FR-ID-09, FR-ID-14), `docs/decisions/0012-auth-library.md`, `docs/decisions/0016-links-and-mail.md`, `docs/decisions/0058-widget-registry-and-tokens.md` |  |
| V6.2.1 | 1 | Пароль не короче 8 знаков | есть | Не короче 12: `src/modules/hdu/input.ts`, `tests/unit/hdu-input.test.ts`. Пароли есть только у сотрудников |  |
| V6.2.2 | 1 | Пользователь может сменить пароль | есть | Сотрудник меняет пароль на странице учётной записи (добавлено при подготовке M9): `tests/integration/staff-password-change.test.ts`, `tests/e2e/asvs-fixes.spec.ts` |  |
| V6.2.3 | 1 | Смена пароля требует текущий и новый | есть | `tests/integration/staff-password-change.test.ts`, `src/modules/hdu/core/staff.ts` |  |
| V6.2.4 | 1 | Пароль сверяется с 3000 самых частых | есть | Список 3000 частых паролей от 12 знаков (добавлен при подготовке M9) и правила частых слов и рядов: `src/modules/hdu/common-passwords.ts`, `tests/unit/password-rules.test.ts` |  |
| V6.2.5 | 1 | Нет правил состава пароля | есть | Только длина: `src/modules/hdu/input.ts` |  |
| V6.2.6 | 1 | Поля пароля type=password | есть | `src/app/[locale]/(auth)/staff/login/StaffLoginForm.tsx`, `src/app/[locale]/(auth)/staff/setup/StaffSetupForm.tsx`, `tests/e2e/staff-login.spec.ts` |  |
| V6.2.7 | 1 | Вставка и менеджеры паролей разрешены | есть | Вставка не запрещена, `autocomplete` current-password и new-password, скрытое поле адреса для менеджера: `src/app/[locale]/(auth)/staff/setup/StaffSetupForm.tsx`, `src/app/[locale]/(agent)/agent/account/PasswordForm.tsx` |  |
| V6.2.8 | 1 | Пароль проверяется как введён, без обрезки и смены регистра | есть | Схема пароля без `trim`: `src/modules/hdu/input.ts`, `src/modules/hdu/api/staff.ts` |  |
| V6.2.9 | 2 | Пароли от 64 знаков допускаются | есть | До 128 знаков: `tests/integration/staff-password-change.test.ts` |  |
| V6.2.10 | 2 | Нет обязательной периодической смены пароля | есть | Срока действия пароля нет: `docs/TZ.md` (FR-ID-09) |  |
| V6.2.11 | 2 | Список слов портала применяется к паролям | есть | `tests/unit/password-rules.test.ts` (Smartup2026Hub, SmartupSupport1 и другие) |  |
| V6.2.12 | 2 | Пароль сверяется с утёкшими паролями | частично | Встроенный список 3000 частых паролей из открытых утечек: `src/modules/hdu/common-passwords.ts` | Полной сверки с базой утечек нет: внешний сервис запрещён правилами `CLAUDE.md`. Владелец: принять или разрешить проверку по k-анонимности (Pwned Passwords) |
| V6.3.1 | 1 | Защита от подбора и перебора учётных данных выполнена | есть | `tests/integration/brute-force.test.ts`, `tests/integration/staff.test.ts`, `tests/integration/staff-password-change.test.ts` |  |
| V6.3.2 | 1 | Нет учётных записей по умолчанию | есть | Первый администратор только командой консоли: `tests/integration/cli.test.ts`, `docs/decisions/0015-staff-onboarding-and-cli.md` |  |
| V6.3.3 | 2 | Многофакторный вход или сочетание факторов | частично | Сотрудник: пароль и обязательный TOTP: `tests/integration/staff.test.ts`. Клиент: вход через Smartup (фактор на стороне Smartup) или одноразовая ссылка на почту и в Telegram | Клиентский вход по ссылке однофакторный (FR-ID-05, FR-ID-14). Владелец: принять отклонение для клиентов |
| V6.3.4 | 2 | Нет неописанных путей входа | есть | Наружу открыт только возврат с сервера Smartup, остальные адреса библиотеки входа 404: `tests/unit/hdu-auth-route.test.ts` |  |
| V6.4.1 | 1 | Начальные пароли и коды активации случайны и короткоживущи | есть | Ссылка приглашения 256 бит, 24 часа, один раз, в базе хеш; пароль задаёт сам сотрудник: `tests/integration/staff.test.ts` |  |
| V6.4.2 | 1 | Нет подсказок пароля и секретных вопросов | есть | Их нет: `src/modules/hdu/api/staff.ts` |  |
| V6.4.3 | 2 | Сброс пароля не обходит второй фактор | есть | Самостоятельного сброса нет; сброс администратором удаляет пароль и второй фактор, сотрудник подключает их заново: `tests/integration/staff-admin.test.ts`, `tests/integration/staff.test.ts` |  |
| V6.4.4 | 2 | Потеря фактора: проверка личности как при выдаче | частично | Восстанавливает только администратор портала или команда консоли: `docs/runbooks/incident.md`, `docs/decisions/0015-staff-onboarding-and-cli.md` | Записать в памятку, как администратор проверяет личность сотрудника перед сбросом (задача 8 подготовки) |
| V6.5.1 | 2 | Коды и одноразовые ссылки действуют один раз | есть | Принятый код TOTP не принимается повторно, ссылка входа тратится: `tests/integration/staff.test.ts`, `tests/integration/login-link.test.ts`, `tests/integration/telegram-login.test.ts` |  |
| V6.5.2 | 2 | Слабые одноразовые секреты хранятся хешем с солью | есть | Резервных кодов нет; токены ссылок 256 бит хранятся SHA-256: `src/modules/hdu/tokens.ts` |  |
| V6.5.3 | 2 | Секреты и ключи TOTP из криптостойкого генератора | есть | `src/modules/hdu/tokens.ts` (crypto.randomBytes), ключ TOTP создаёт библиотека входа: `src/modules/hdu/auth/options.ts` |  |
| V6.5.4 | 2 | Одноразовые коды от 20 бит | есть | Токены ссылок 256 бит, TOTP 6 цифр: `src/modules/hdu/tokens.ts` |  |
| V6.5.5 | 2 | Срок внеполосных кодов до 10 минут, TOTP 30 секунд | частично | Ссылка из бота 10 минут, TOTP 30 секунд: `src/modules/hdu/pref.ts`, `tests/integration/telegram-login.test.ts`. Ссылка входа на почту 15 минут по FR-ID-05: `tests/integration/login-link.test.ts` | Владелец: сократить FR-ID-05 до 10 минут (правка ТЗ и одной константы) или принять отклонение |
| V6.6.1 | 2 | Коды по телефону и SMS | не применимо | SMS и звонки для входа не используются |  |
| V6.6.2 | 2 | Внеполосный код привязан к своему запросу | частично | Каждая ссылка одноразовая и живёт 10-15 минут: `tests/integration/login-link.test.ts` | Новая ссылка не отменяет прежние, ссылка не привязана к браузеру запроса (её открывают на телефоне, FR-ID-05). Владелец: принять или отменять прежние ссылки при новой |
| V6.6.3 | 2 | Внеполосный код защищён от подбора | есть | 256 бит и предел 30 попыток за 10 минут с адреса: `tests/integration/brute-force.test.ts` |  |
| V6.8.1 | 2 | Несколько поставщиков входа не дают подменить человека | есть | Пользователь по паре "сервер и sub", email не объединяет записи: `tests/integration/sso-flow.test.ts` |  |
| V6.8.2 | 2 | Подписи утверждений входа всегда проверяются | есть | id_token по JWKS сервера, токен контекста виджета по подписи: `tests/integration/provision.test.ts`, `tests/unit/hdu-context-token.test.ts` |  |
| V6.8.3 | 2 | Утверждения SAML используются один раз | не применимо | SAML не используется |  |
| V6.8.4 | 2 | Сила входа у поставщика проверяется по acr, amr, auth_time | не применимо | Портал не требует от Smartup особой силы входа; сотрудники входят только паролем и TOTP портала |  |

## V7. Сессии

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V7.1.1 | 2 | Документ: срок бездействия и предельный срок сессии с обоснованием | частично | `docs/TZ.md` (FR-ID-10): клиент 30 дней с продлением, сотрудник 12 часов без продления; `docs/decisions/0014-identity-access.md` | Нет обоснования отступлений от NIST SP 800-63B и срока бездействия сотрудника. Владелец: решение по 7.3.1 и 7.3.2 |
| V7.1.2 | 2 | Документ: сколько параллельных сессий допускается | частично | FR-ID-11 в `docs/TZ.md`: список сессий и завершение | Предела параллельных сессий нет и это не записано как решение. Владелец: подтвердить "без предела" |
| V7.1.3 | 2 | Документ: сессии при едином входе (SSO) | частично | Сессия портала не зависит от сессии Smartup: `docs/decisions/0012-auth-library.md`, `docs/decisions/0013-identity-and-email.md` | Не записано, что выход из Smartup не завершает сессию портала. Дописать решением при M9 |
| V7.2.1 | 1 | Токен сессии проверяется на сервере | есть | Сессии в базе, проверка библиотекой входа на каждом запросе: `src/modules/hdu/api/request.ts`, `tests/integration/sessions.test.ts` |  |
| V7.2.2 | 1 | Токены сессии создаются динамически | есть | `src/modules/hdu/auth/options.ts`, `tests/integration/sessions.test.ts` |  |
| V7.2.3 | 1 | Ссылочный токен уникален, из CSPRNG, от 128 бит | есть | Случайный токен сессии библиотеки входа, кука подписана `BETTER_AUTH_SECRET`: `src/modules/hdu/auth/options.ts`, `tests/integration/auth-instance.test.ts` |  |
| V7.2.4 | 1 | Новый токен при входе, прежний завершается | есть | Повторный вход в том же браузере отзывает прежнюю сессию: `src/modules/hdu/api/staff.ts`, `tests/integration/staff.test.ts` |  |
| V7.3.1 | 2 | Срок бездействия с повторным входом | частично | Клиент: 30 дней без активности: `tests/integration/sso-flow.test.ts`. Сотрудник: срока бездействия нет, только 12 часов | Владелец: срок бездействия сотрудника (например, 30 минут) или принять 12 часов |
| V7.3.2 | 2 | Предельный срок сессии | частично | Сотрудник 12 часов без продления: `tests/integration/staff.test.ts`. Клиент продлевается при каждом заходе без предела | Владелец: предельный срок сессии клиента (например, 90 дней) или принять отклонение |
| V7.4.1 | 1 | Завершённая сессия больше не действует | есть | `tests/integration/sessions.test.ts`, `tests/e2e/sessions.spec.ts` |  |
| V7.4.2 | 1 | Отключение учётной записи завершает все сессии | есть | `tests/integration/members.test.ts`, `tests/integration/staff-admin.test.ts` |  |
| V7.4.3 | 2 | После смены фактора можно завершить другие сессии | есть | Смена пароля завершает все сессии сотрудника, подключение и сброс второго фактора тоже: `tests/integration/staff-password-change.test.ts`, `tests/integration/staff.test.ts` |  |
| V7.4.4 | 2 | Выход виден на всех страницах после входа | есть | Меню пользователя в шапке кабинета и рабочего места, кнопка на шагах после входа: `src/ui/shell/UserMenuContent.tsx`, `src/ui/shell/SignOutForm.tsx`, `tests/e2e/sessions.spec.ts` |  |
| V7.4.5 | 2 | Администратор завершает сессии пользователя или всех | частично | Сброс сотрудника и отключение участника завершают его сессии: `tests/integration/staff-admin.test.ts`, `tests/integration/members.test.ts`. Все сессии сразу: команда базы из `docs/runbooks/incident.md` | Кнопки "завершить все сессии портала" нет. Владелец: нужна ли |
| V7.5.1 | 2 | Повторный вход перед сменой важных атрибутов (email, второй фактор) | частично | Смена пароля требует текущий пароль, второй фактор меняет только сброс администратором (со свежим входом): `tests/integration/staff-password-change.test.ts`, `tests/integration/admin-fresh.test.ts` | Клиент меняет адрес почты (им входят по ссылке) без повторного входа, только подтверждением нового адреса. Владелец: принять или требовать повторный вход |
| V7.5.2 | 2 | Просмотр и завершение своих сессий с повторным входом | частично | Список и завершение есть: `tests/integration/sessions.test.ts`, `tests/e2e/sessions.spec.ts` | Повторного входа перед завершением нет (FR-ID-11). Владелец: принять отклонение |
| V7.6.1 | 2 | Сроки сессий между порталом и поставщиком входа | частично | Сессия портала своя, после входа через Smartup не продлевается Smartup: `docs/decisions/0012-auth-library.md` | Как 7.1.3: записать решение |
| V7.6.2 | 2 | Сессия создаётся только действием пользователя | есть | Вход через Smartup по кнопке, ссылка входа по кнопке на странице (сканеры её не тратят), виджет по открытию человеком: `tests/e2e/login-link.spec.ts`, `docs/decisions/0016-links-and-mail.md`, `docs/decisions/0058-widget-registry-and-tokens.md` |  |

## V8. Авторизация

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V8.1.1 | 1 | Документ: права на функции и данные | есть | `docs/TZ.md` (раздел 10.3, роли FR-ADM), `docs/decisions/0014-identity-access.md`, `docs/decisions/0019-admin-settings-audit-policy.md` |  |
| V8.1.2 | 2 | Документ: права на поля | есть | `docs/TZ.md` (раздел 10.3), триггеры записи полей в миграциях, например `drizzle/0035_email_intake.sql` |  |
| V8.2.1 | 1 | Доступ к функциям только с явным правом | есть | Роль проверяется на каждом запросе, отказ 404 и запись authz.denied (добавлено при подготовке M9): `tests/integration/isolation/staff-roles.test.ts`, `tests/integration/authz-denied.test.ts` |  |
| V8.2.2 | 1 | Доступ к данным только к своим объектам (IDOR, BOLA) | есть | RLS на каждой таблице и набор изоляции: `tests/integration/isolation/registry.test.ts`, `tests/integration/isolation/tickets-direct.test.ts`, `tests/integration/client-scope.test.ts` |  |
| V8.2.3 | 2 | Доступ к полям только с правом (BOPLA) | есть | Триггеры защиты полей и колоночные права: `tests/integration/isolation/tickets-writes.test.ts`, `tests/integration/isolation/ideas-writes.test.ts` |  |
| V8.3.1 | 1 | Права проверяются на доверенном сервере | есть | Актор строится на сервере из сессии, права держит база (FORCE RLS): `src/db/with-actor.ts`, `tests/unit/migrations-force-rls.test.ts` |  |
| V8.4.1 | 2 | Изоляция арендаторов | есть | `tests/integration/isolation/registry.test.ts`, `tests/integration/rls-base.test.ts`, `tests/integration/client-scope.test.ts` |  |

## V9. Самодостаточные токены

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V9.1.1 | 1 | Самодостаточный токен проверяется подписью до чтения | есть | Токен контекста и токен виджета: `tests/unit/hdu-context-token.test.ts`, `tests/integration/embed-session.test.ts` |  |
| V9.1.2 | 1 | Алгоритмы по списку, без none | есть | Список по режиму сервера (ES256, EdDSA, RS256 или HS256), токен виджета только HS256: `src/modules/hdu/core/context-token.ts`, `src/modules/hdu/core/embed-token.ts`, `tests/unit/hdu-context-token.test.ts` |  |
| V9.1.3 | 1 | Ключи из заранее заданных источников, jku, x5u, jwk отклоняются | есть | Адрес ключей из реестра сервера, заголовки с ключом отклоняются: `src/modules/hdu/core/context-token.ts`, `tests/unit/hdu-context-token.test.ts` |  |
| V9.2.1 | 1 | Срок токена (exp, nbf) проверяется | есть | `tests/unit/hdu-context-token.test.ts`, `tests/unit/widget-session-renewal.test.ts` |  |
| V9.2.2 | 2 | Тип и назначение токена проверяются | есть | Свой получатель у токена контекста и у токена виджета, обязательные поля: `src/modules/hdu/core/embed-token.ts`, `tests/integration/embed-session.test.ts` |  |
| V9.2.3 | 2 | Токен принимается только для своего получателя (aud) | есть | `src/modules/hdu/core/context-token.ts`, `tests/unit/hdu-context-token.test.ts` |  |
| V9.2.4 | 2 | Один ключ на разных получателей: получатель в токене | есть | Токен виджета подписан своим секретом с получателем портала, общий секрет сервера свой у каждого сервера: `src/modules/hdu/core/embed-token.ts`, `docs/decisions/0058-widget-registry-and-tokens.md` |  |

## V10. OAuth и OIDC

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V10.1.1 | 2 | Токены только тем частям, которым нужны | есть | Токены Smartup не хранятся и в браузер не уходят: `tests/integration/sso-flow.test.ts` |  |
| V10.1.2 | 2 | Код и id_token только из потока этого браузера | есть | Кука состояния и PKCE S256: `tests/integration/sso-flow.test.ts` |  |
| V10.2.1 | 2 | Защита потока кода от CSRF (PKCE или state) | есть | `tests/integration/sso-flow.test.ts` (начало входа ставит куку состояния и просит PKCE) |  |
| V10.2.2 | 2 | Защита от подмены сервера авторизации (mix-up) | есть | У каждого сервера свой адрес возврата `/api/auth/sso/callback/{код}`, `iss` id_token сверяется с сервером реестра: `tests/integration/sso-flow.test.ts`, `tests/integration/servers.test.ts` |  |
| V10.3.1 | 2 | Сервер ресурсов: получатель токена доступа | не применимо | Портал не принимает токенов доступа OAuth |  |
| V10.3.2 | 2 | Сервер ресурсов: права из токена | не применимо | Портал не принимает токенов доступа OAuth |  |
| V10.3.3 | 2 | Сервер ресурсов: пользователь по iss и sub | не применимо | Портал не принимает токенов доступа OAuth; сам вход по паре сервера и sub: 10.5.2 |  |
| V10.3.4 | 2 | Сервер ресурсов: сила входа из токена | не применимо | Портал не принимает токенов доступа OAuth |  |
| V10.4.1 | 1 | Сервер авторизации: адреса возврата по точному списку | не применимо | Портал не сервер авторизации |  |
| V10.4.2 | 1 | Сервер авторизации: код один раз | не применимо | Портал не сервер авторизации |  |
| V10.4.3 | 1 | Сервер авторизации: короткий срок кода | не применимо | Портал не сервер авторизации |  |
| V10.4.4 | 1 | Сервер авторизации: только нужные гранты | не применимо | Портал не сервер авторизации |  |
| V10.4.5 | 1 | Сервер авторизации: повтор токена обновления | не применимо | Портал не сервер авторизации |  |
| V10.4.6 | 2 | Сервер авторизации: обязательный PKCE | не применимо | Портал не сервер авторизации |  |
| V10.4.7 | 2 | Сервер авторизации: динамическая регистрация клиентов | не применимо | Портал не сервер авторизации |  |
| V10.4.8 | 2 | Сервер авторизации: предельный срок токена обновления | не применимо | Портал не сервер авторизации |  |
| V10.4.9 | 2 | Сервер авторизации: отзыв токенов пользователем | не применимо | Портал не сервер авторизации |  |
| V10.4.10 | 2 | Сервер авторизации: проверка конфиденциального клиента | не применимо | Портал не сервер авторизации |  |
| V10.4.11 | 2 | Сервер авторизации: только нужные области | не применимо | Портал не сервер авторизации |  |
| V10.5.1 | 2 | Клиент защищён от повтора id_token (nonce) | частично | id_token приходит только из обмена кода с PKCE и кукой состояния: `tests/integration/sso-flow.test.ts` | Библиотека входа (@better-auth/sso 1.7.22) не посылает nonce. Владелец: принять или поставить задачу при обновлении библиотеки |
| V10.5.2 | 2 | Пользователь по sub, который не переназначается | есть | `tests/integration/sso-flow.test.ts`, `tests/integration/provision.test.ts` |  |
| V10.5.3 | 2 | Издатель в метаданных совпадает с заданным | есть | Проверка сервера сверяет issuer документа discovery: `tests/integration/servers.test.ts`, `src/modules/hdu/pref.ts` (issuer_mismatch) |  |
| V10.5.4 | 2 | aud id_token равен client_id | есть | Проверяет библиотека входа: id_token по JWKS с aud равным client_id и issuer сервера, проверено чтением @better-auth/sso 1.7.22 (validateOIDCIdToken); `docs/security/asvs-m1.md` (V10), `tests/integration/provision.test.ts` |  |
| V10.5.5 | 2 | Back-channel logout | не применимо | Выход по каналу сервера не используется |  |
| V10.6.1 | 2 | Провайдер OpenID: допустимые response_mode | не применимо | Портал не провайдер OpenID |  |
| V10.6.2 | 2 | Провайдер OpenID: принудительный выход | не применимо | Портал не провайдер OpenID |  |
| V10.7.1 | 2 | Сервер авторизации: согласие пользователя | не применимо | Портал не сервер авторизации |  |
| V10.7.2 | 2 | Сервер авторизации: понятный запрос согласия | не применимо | Портал не сервер авторизации |  |
| V10.7.3 | 2 | Сервер авторизации: пересмотр согласий | не применимо | Портал не сервер авторизации |  |

## V11. Криптография

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V11.1.1 | 2 | Политика управления ключами и их жизненного цикла | частично | Смена каждого секрета описана: `docs/runbooks/incident.md` (раздел 3), замена ключа шифрования без простоя: `tests/integration/key-rotation.test.ts` | Политики по NIST SP 800-57 (кто владеет ключом, сроки смены) нет. Владелец: утвердить сроки смены и хранение в менеджере паролей |
| V11.1.2 | 2 | Перечень криптографии: ключи, алгоритмы, где применяются | есть | Раздел "Криптография портала" ниже в этом файле; `src/security/secret-box.ts`, `src/modules/hdu/tokens.ts` | Обновлять при новом ключе или алгоритме |
| V11.2.1 | 2 | Проверенные реализации криптографии | есть | `node:crypto`, jose, библиотека входа, age: `docs/versions.md` |  |
| V11.2.2 | 2 | Гибкость: алгоритмы и ключи заменяемы | есть | Версия в формате шифротекста, прежний ключ на время замены, перешифрование командой: `src/security/secret-box.ts`, `tests/unit/secret-box.test.ts`, `tests/integration/key-rotation.test.ts` |  |
| V11.2.3 | 2 | Не меньше 128 бит стойкости | есть | AES-256-GCM, HMAC-SHA256, SHA-256, ES256 и EdDSA: `src/security/secret-box.ts`, `src/modules/hdu/core/context-token.ts` | Длину ключа RS256 сервера Smartup портал не проверяет: попросить разработчиков Smartup ключ от 3072 бит или ES256 |
| V11.3.1 | 1 | Нет ECB и слабых дополнений | есть | Только AES-GCM: `src/security/secret-box.ts` |  |
| V11.3.2 | 1 | Только одобренные шифры и режимы (AES-GCM) | есть | `src/security/secret-box.ts`, `tests/unit/secret-box.test.ts` |  |
| V11.3.3 | 2 | Шифрование с проверкой подлинности | есть | AES-GCM с меткой и контекстом: `tests/unit/secret-box.test.ts` |  |
| V11.4.1 | 1 | Одобренные хеш-функции, без MD5 | есть | SHA-256 и HMAC-SHA256; HMAC-SHA1 только в TOTP по RFC 6238: `src/modules/hdu/tokens.ts`, `src/modules/hdw/webhook-sign.ts` |  |
| V11.4.2 | 2 | Пароли хешируются стойкой функцией | есть | scrypt библиотеки входа: `src/modules/hdu/api/staff.ts` |  |
| V11.4.3 | 2 | Хеши целостности стойки к коллизиям, от 256 бит | есть | SHA-256 файлов и подписей: `src/modules/hdc/scan.ts`, `src/modules/hdw/tracker-sign.ts` |  |
| V11.4.4 | 2 | Ключи из паролей через KDF с растяжением | не применимо | Ключи из паролей не выводятся |  |
| V11.5.1 | 2 | Неугадываемые значения из CSPRNG, от 128 бит | есть | Токены 256 бит, одноразовый код CSP 128 бит, ключ встраивания 128 бит; UUID секретами не служат: `src/modules/hdu/tokens.ts`, `src/security/csp.ts` |  |
| V11.6.1 | 2 | Одобренные алгоритмы создания ключей и подписей | есть | Подписи ES256, EdDSA, RS256 через jose; ключи копий `age-keygen` (X25519): `src/modules/hdu/core/context-token.ts`, `docs/runbooks/incident.md` |  |

## V12. Защищённая связь

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V12.1.1 | 1 | Только TLS 1.2 и 1.3 | частично | TLS завершают Cloudflare и Caddy: `Caddyfile` | staging: проверить при первой выкладке (памятка запуска): минимальная версия TLS в Cloudflare и Caddy |
| V12.1.2 | 2 | Только рекомендованные наборы шифров | частично | `Caddyfile` (наборы Caddy по умолчанию) | staging: проверить при первой выкладке (памятка запуска): проверка наборов (например, testssl.sh) |
| V12.1.3 | 2 | Сертификаты клиента mTLS проверяются | не применимо | Вход по сертификату клиента не используется; Caddy отвечает только адресам Cloudflare: `tests/unit/compose-prod.test.ts` |  |
| V12.2.1 | 1 | TLS для всех внешних сервисов HTTP без отката | частично | HSTS и автоматический https Caddy: `Caddyfile` | staging: проверить при первой выкладке (памятка запуска): Cloudflare Full strict |
| V12.2.2 | 1 | Публично доверенные сертификаты | частично | Сертификат Cloudflare на краю и Caddy за ним: `docs/runbooks/launch.md` | staging: проверить при первой выкладке (памятка запуска) |
| V12.3.1 | 2 | Шифрование всех входящих и исходящих соединений | частично | Исходящие к внешним сервисам только https: `src/security/outbound.ts`, `tests/unit/outbound.test.ts`. База, ClamAV и TEI внутри сетей Docker одного сервера без TLS: `compose.prod.yaml` | Отклонение 12.3: владелец принимает открытые соединения внутри сервера или просит TLS к базе |
| V12.3.2 | 2 | Клиенты TLS проверяют сертификаты | есть | Проверка сертификатов Node.js не отключается нигде (в `src` нет `rejectUnauthorized`): `src/security/outbound.ts` |  |
| V12.3.3 | 2 | TLS между внутренними сервисами HTTP | нет | Caddy, портал и TEI общаются по http внутри сетей Docker одного сервера: `compose.prod.yaml`, `tests/unit/compose-prod.test.ts` (сети разделены) | Отклонение 12.3, решает владелец |
| V12.3.4 | 2 | Доверенные сертификаты между внутренними сервисами | не применимо | Внутреннего TLS нет, см. 12.3.3 |  |

## V13. Конфигурация

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V13.1.1 | 2 | Документ: все внешние связи портала | частично | `docs/TZ.md` (разделы 11.11 и 14.6), `docs/runbooks/launch.md` | Список исходящих узлов одним местом в памятке запуска (задача 8 подготовки) |
| V13.2.1 | 2 | Связи компонентов с проверкой подлинности | частично | База: отдельная роль с паролем на каждую службу: `docs/decisions/0003-db-driver-roles-and-volume.md`, `tests/integration/db-roles.test.ts`. ClamAV и TEI без проверки подлинности, доступны только из своей сети | Отклонение: ClamAV и TEI в закрытой сети без паролей. Владелец |
| V13.2.2 | 2 | Наименьшие права между компонентами | есть | Роли `hub_app`, `hub_auth`, `hub_owner`, `hub_hdi_counter`; контейнеры не от root, только чтение: `tests/integration/db-roles.test.ts`, `tests/unit/compose-prod.test.ts`, `tests/integration/isolation/ideas-counter-role.test.ts` |  |
| V13.2.3 | 2 | Нет учётных данных по умолчанию | есть | Пароли ролей и секреты обязательны и проверяются при запуске: `tests/unit/env.test.ts`, `tests/unit/compose-prod.test.ts` |  |
| V13.2.4 | 2 | Список разрешённых внешних систем | частично | Портал закрывает внутренние адреса, база без выхода наружу: `src/security/outbound.ts`, `tests/unit/compose-prod.test.ts` | Списка разрешённых внешних узлов на сетевом экране нет. staging: проверить при первой выкладке (памятка запуска) |
| V13.2.5 | 2 | Сервер ходит только по списку разрешённых адресов | частично | Как 13.2.4: `src/security/outbound.ts` | Правило исходящих на сетевом экране хостинга. staging: проверить при первой выкладке (памятка запуска) |
| V13.3.1 | 2 | Хранилище секретов | частично | Секреты в `.env` с правами 600 и в менеджере паролей, в репозитории только пример: `docs/runbooks/launch.md`, `.env.example` | Отклонение: отдельного хранилища секретов (vault) нет. Владелец |
| V13.3.2 | 2 | Доступ к секретам по наименьшим правам | есть | Ключ модели только у фонового процесса, у служб только свои переменные: `compose.prod.yaml`, `tests/unit/compose-prod.test.ts` |  |
| V13.4.1 | 1 | Нет метаданных системы версий в выкладке | есть | Образ собирается из `standalone`, `.git` исключён: `Dockerfile` |  |
| V13.4.2 | 2 | Режимы отладки выключены в production | есть | Витрина, заглушка модели и почта в файл запрещены на настоящем адресе: `tests/unit/env.test.ts`, `src/env.ts` |  |
| V13.4.3 | 2 | Нет списков каталогов | есть | Caddy без file_server, Next.js отдаёт только файлы сборки: `Caddyfile` |  |
| V13.4.4 | 2 | Метод TRACE не поддерживается | есть | Caddy отвечает 405 на TRACE и TRACK (исправлено при подготовке M9, Next.js отвечал 500): `Caddyfile`, `tests/unit/compose-prod.test.ts` |  |
| V13.4.5 | 2 | Документация и адреса наблюдения не открыты без надобности | есть | Открыты только `/api/health`, `/api/ready`, `/api/ready/worker` без подробностей: `tests/integration/ready.test.ts`, `tests/integration/worker-heartbeat.test.ts` |  |

## V14. Защита данных

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V14.1.1 | 2 | Чувствительные данные найдены и разделены по уровням | частично | Перечень личных данных: `docs/TZ.md` (раздел 14.6) | Уровней защиты нет. Владелец с юристом (вопрос 10 ТЗ) |
| V14.1.2 | 2 | Требования защиты по уровням | частично | Сроки хранения и что уходит наружу: `docs/TZ.md` (разделы 14.3 и 14.6) | Как 14.1.1 |
| V14.2.1 | 1 | Чувствительное не передаётся в адресе | частично | Ключи и сессии только в заголовках и теле; токен мобильной страницы во фрагменте и убирается сразу: `tests/e2e/widget-mobile.spec.ts`. Ссылки входа и приглашений несут токен в адресе, Caddy вырезает его из журнала: `tests/unit/compose-prod.test.ts` | Отклонение: одноразовые ссылки из писем с токеном в адресе (FR-ID-05, FR-ID-09), решение 0016 |
| V14.2.2 | 2 | Чувствительное не кешируется на сервере | есть | Данные клиентов не кешируются (правило `use-cache` в `scripts/checks/forbidden-apis.mjs`), `Cache-Control: no-store`: `tests/e2e/csp-all-pages.spec.ts`, `docs/decisions/0002-cache-and-image-optimizer-off.md` |  |
| V14.2.3 | 2 | Чувствительное не уходит недоверенным сторонам | есть | Нет счётчиков и трекеров, `connect-src 'self'`: `src/security/csp.ts`; в модель только перечень 14.3: `docs/security/ai-injection-review.md` |  |
| V14.2.4 | 2 | Защита данных по документированным уровням | частично | Шифрование секретов, сроки хранения, журнал без текстов: `tests/integration/retention.test.ts`, `tests/integration/audit.test.ts` | Зависит от 14.1.1 |
| V14.3.1 | 1 | Данные удаляются из браузера после выхода | есть | Выход убирает черновики и другие записи портала из хранилищ браузера (добавлено при подготовке M9): `src/ui/drafts.ts`, `tests/unit/drafts.test.ts`, `tests/e2e/asvs-fixes.spec.ts` |  |
| V14.3.2 | 2 | Cache-Control: no-store против кеша браузера | есть | Каждая страница `no-store`: `tests/e2e/csp-all-pages.spec.ts`; ответы API: `src/modules/hdc/util.ts`, `tests/integration/ready.test.ts` |  |
| V14.3.3 | 2 | В хранилищах браузера нет чувствительных данных | частично | Черновики обращений и ответов на устройстве (UX-C-02), удаляются после отправки и при выходе: `docs/decisions/0026-client-tickets.md`, `tests/unit/drafts.test.ts` | Отклонение: черновик с текстом обращения хранится в localStorage до отправки или выхода (UX-C-02). Владелец |

## V15. Безопасное программирование и архитектура

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V15.1.1 | 1 | Документ: сроки устранения уязвимых зависимостей | частично | Dependabot и проверка `pnpm audit` в CI, выдержка новых версий 7 дней: `docs/decisions/0024-dependabot-while-ci-off.md`, `docs/decisions/0001-stack-pins.md` | Сроков (например, критичная за 7 дней) нет. Владелец |
| V15.1.2 | 2 | Перечень сторонних библиотек (SBOM) из доверенных источников | есть | Файл блокировок с хешами и точные версии: `docs/versions.md`, `scripts/versions.mjs` |  |
| V15.1.3 | 2 | Документ: тяжёлые функции и защита от перегрузки | есть | `docs/audit/2026-11-23-technical-audit.md` (раздел 4), `docs/decisions/0039-scale-and-recovery.md`, `docs/TZ.md` (раздел 14.5) |  |
| V15.2.1 | 1 | Компоненты в пределах сроков обновления | частично | Проверка `pnpm audit` в CI: `.github/workflows/ci.yml` | Зависит от 15.1.1 |
| V15.2.2 | 2 | Защита от перегрузки тяжёлыми функциями | есть | Пределы частоты, листание, пределы времени запросов и задач: `tests/integration/rate-limit.test.ts`, `tests/perf/suggest-p95.test.ts`, `tests/integration/tx-budget.test.ts` |  |
| V15.2.3 | 2 | В production только нужное, без отладочного кода | есть | Ложные серверы и витрина в образ не попадают или закрыты: `Dockerfile`, `tests/unit/env.test.ts` |  |
| V15.3.1 | 1 | Возвращаются только нужные поля | есть | Запросы выбирают поля явно, клиенту не видны теги и заметки: `tests/integration/tickets-read.test.ts`, `tests/integration/embed-tickets.test.ts` |  |
| V15.3.2 | 2 | Исходящие запросы не идут за переадресацией | есть | `src/security/outbound.ts`, `src/modules/hdu/url-safety.ts`, `tests/unit/outbound.test.ts`, `tests/unit/hdn-resend.test.ts` |  |
| V15.3.3 | 2 | Защита от массового присвоения полей | есть | Строгие схемы на каждое действие, поля сверх схемы отклоняются; база защищает поля триггерами: `tests/integration/isolation/tickets-writes.test.ts`, `tests/unit/hdu-input.test.ts` |  |
| V15.3.4 | 2 | Настоящий адрес посетителя из доверенного поля | есть | `docs/decisions/0020-client-ip-source.md`, `tests/unit/hdc-util.test.ts`, `tests/unit/compose-prod.test.ts` |  |
| V15.3.5 | 2 | Строгие типы и сравнения | есть | TypeScript strict, разбор ввода схемами Zod: `tests/unit/hdt-input.test.ts` |  |
| V15.3.6 | 2 | Защита от загрязнения прототипа | частично | Ввод разбирается схемами Zod в новые объекты, поиск по ключам ввода через `Map` и `Set` в правилах: `src/modules/hdu/password-rules.ts` | Отдельной проверки линтером нет. Поставить задачей (правило no-prototype-builtins и тест на `__proto__` в схемах) |
| V15.3.7 | 2 | Защита от загрязнения параметров HTTP | есть | Параметр адреса берётся одним значением: `src/lib/search-params.ts`; поля форм по имени: `tests/unit/hdu-input.test.ts` |  |

## V16. Журналы и обработка ошибок

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V16.1.1 | 2 | Перечень журналов: что, где, сколько хранится, кто читает | частично | `docs/TZ.md` (разделы 13.8 и 14.6), `docs/decisions/0037-ops-readiness.md` | Единого перечня нет. Дописать в памятку запуска (задача 8 подготовки) |
| V16.2.1 | 2 | В записи журнала когда, где, кто, что | есть | Журнал аудита: автор, время и адрес ставит база: `tests/integration/audit.test.ts`; журнал процесса: время, уровень, событие: `tests/unit/log.test.ts` |  |
| V16.2.2 | 2 | Время в UTC или со смещением | есть | `src/lib/log.ts` (toISOString), `timestamptz` в журнале аудита |  |
| V16.2.3 | 2 | Журналы только в описанные места | есть | stdout процессов, таблица аудита, выгрузка аудита в бакет копий: `docs/decisions/0037-ops-readiness.md`, `scripts/ops/audit-export.sh` |  |
| V16.2.4 | 2 | Общий формат для обработчика журналов | есть | Строки JSON: `tests/unit/log.test.ts` |  |
| V16.2.5 | 2 | Чувствительное в журнале по уровню защиты | есть | Поля секретов вырезаются, аудит отклоняет поля-секреты, Caddy вырезает токены: `tests/unit/log.test.ts`, `tests/integration/audit.test.ts`, `tests/unit/compose-prod.test.ts` |  |
| V16.3.1 | 2 | Каждый вход в журнале, удачный и нет, со способом | есть | `tests/integration/audit-sign-in.test.ts`, `tests/integration/staff.test.ts` |  |
| V16.3.2 | 2 | Отказы в доступе в журнале | частично | Отказ в разделе рабочего места пишется событием `authz.denied` (добавлено при подготовке M9): `tests/integration/authz-denied.test.ts` | Отказ на уровне данных (RLS не отдаёт строку, ответ 404) не пишется: отличить его от опечатки в адресе нельзя. Владелец: принять |
| V16.3.3 | 2 | События безопасности и попытки обхода в журнале | частично | Неудачные входы, блокировки, пределы частоты, нарушения CSP, заражённые файлы: `tests/integration/brute-force.test.ts`, `tests/integration/csp-report.test.ts`, `tests/integration/attachment-scan.test.ts` | Перечня событий безопасности одним документом нет (см. 16.1.1) |
| V16.3.4 | 2 | Неожиданные ошибки и сбои защиты в журнале | есть | Ошибки процессов и сигналы дежурным: `tests/integration/ops-watch.test.ts`, `tests/integration/ops-watch-backup.test.ts`, `tests/unit/log.test.ts` |  |
| V16.4.1 | 2 | Защита от внедрения в журнал | есть | Каждая запись одна строка JSON: `tests/unit/log.test.ts` |  |
| V16.4.2 | 2 | Журналы защищены от чтения и изменения | частично | Журнал аудита только для добавления, удаляет только ночная очистка старше 3 лет: `tests/integration/retention.test.ts`. Журналы процессов у Docker на сервере | staging: проверить при первой выкладке (памятка запуска): доступ к журналам Docker только у root |
| V16.4.3 | 2 | Журналы уходят в отдельную систему | частично | Журнал аудита раз в сутки уходит зашифрованным в бакет копий: `scripts/ops/audit-export.sh`, `tests/unit/audit-export.test.ts` | Журналы процессов наружу не уходят: внешний сервис ждёт решения владельца (решение 4 плана подготовки) |
| V16.5.1 | 2 | Общее сообщение при неожиданной ошибке | есть | Ответы problem+json без подробностей, проверки готовности без текста ошибок: `src/modules/hdc/util.ts`, `tests/integration/ready.test.ts`, `tests/integration/worker-heartbeat.test.ts` |  |
| V16.5.2 | 2 | Портал работает при сбое внешнего сервиса | есть | Smartup недоступен, почта и вебхуки с повторами, без Turnstile действуют пределы: `tests/integration/sso-flow.test.ts`, `tests/integration/outbox.test.ts`, `docs/decisions/0018-external-services-in-m1.md` |  |
| V16.5.3 | 2 | Отказ безопасно, без открытия при ошибке | есть | Непроверенный антивирусом файл не отдаётся, испорченный список встраивания даёт запрет: `tests/integration/attachment-scan.test.ts`, `src/proxy.ts`, `tests/unit/compose-prod.test.ts` |  |

## V17. WebRTC

| № | Ур. | Требование | Состояние | Доказательство | Что сделать |
|---|---|---|---|---|---|
| V17.1.1 | 2 | TURN только к общим адресам | не применимо | WebRTC не используется |  |
| V17.2.1 | 2 | Ключ сертификата DTLS | не применимо | WebRTC не используется |  |
| V17.2.2 | 2 | Наборы DTLS медиасервера | не применимо | WebRTC не используется |  |
| V17.2.3 | 2 | Проверка подлинности SRTP | не применимо | WebRTC не используется |  |
| V17.2.4 | 2 | Медиасервер переживает испорченные пакеты SRTP | не применимо | WebRTC не используется |  |
| V17.3.1 | 2 | Сигнальный сервер под потоком | не применимо | WebRTC не используется |  |
| V17.3.2 | 2 | Сигнальный сервер и испорченные сообщения | не применимо | WebRTC не используется |  |

## Криптография портала

Перечень ключей и алгоритмов (требование 11.1.2). Значения ключей хранятся в `.env` на сервере и в менеджере паролей владельца, смена каждого описана в `docs/runbooks/incident.md`, раздел 3.

| Ключ или средство | Алгоритм | Для чего | Где в коде |
|---|---|---|---|
| `ENCRYPTION_KEY` (и `ENCRYPTION_KEY_PREVIOUS` на время замены) | AES-256-GCM, формат `v1` с контекстом | Секреты клиентов OAuth серверов Smartup, токен бота дежурных, секреты исходящих вебхуков; ключ HMAC запросов подсказки | `src/security/secret-box.ts`, `src/modules/hdk/api/suggest.ts` |
| `BETTER_AUTH_SECRET` | HMAC-SHA256 | Подпись кук библиотеки входа, подпись ссылок локального хранилища | `src/modules/hdu/auth/options.ts`, `src/modules/hdc/storage/index.ts` |
| Пароли сотрудников | scrypt (библиотека входа) | Хранение пароля | `src/modules/hdu/api/staff.ts` |
| Второй фактор | TOTP RFC 6238 (HMAC-SHA1, 6 цифр, 30 секунд) | Вход сотрудника | `src/modules/hdu/auth/options.ts` |
| Одноразовые ссылки и токены | 256 бит из `randomBytes`, в базе SHA-256 | Приглашения, ссылки входа, подтверждение почты, привязка Telegram | `src/modules/hdu/tokens.ts` |
| `REPLY_HMAC_SECRET` (и `_PREVIOUS`) | HMAC-SHA256, сравнение за постоянное время | Подпись адреса ответа на письмо, ссылка оценки | `src/modules/hdn/inbound/reply-address.ts`, `src/modules/hdt/csat-link.ts` |
| `EMBED_TOKEN_SECRET` | HS256 (JWT, jose) | Токен сессии виджета | `src/modules/hdu/core/embed-token.ts` |
| Ключи серверов Smartup для токена контекста | ES256, EdDSA, RS256 по JWKS или HS256 общим секретом | Проверка токена контекста виджета | `src/modules/hdu/core/context-token.ts` |
| `RESEND_WEBHOOK_SECRET` | HMAC-SHA256 (Svix) | Проверка вебхука почты | `tests/unit/hdn-svix.test.ts` |
| `TELEGRAM_WEBHOOK_SECRET` | Сравнение за постоянное время | Проверка вебхука бота | `src/modules/hdn/telegram.ts` |
| Секреты исходящих вебхуков и `DEV_TRACKER_WEBHOOK_SECRET` | HMAC-SHA256 с меткой времени | Подпись исходящих вебхуков и проверка вебхука таск-менеджера | `src/modules/hdw/webhook-sign.ts`, `src/modules/hdw/tracker-sign.ts` |
| Одноразовый код CSP | 128 бит из `crypto.getRandomValues` | Встроенные скрипты и стили страницы | `src/security/csp.ts` |
| Ключ копий | age (X25519), закрытый ключ только у владельца | Шифрование копий базы, архива журнала и выгрузки аудита | `scripts/ops/backup.sh`, `scripts/ops/audit-export.sh` |
| TLS | Cloudflare на краю, Caddy за ним | Связь с посетителем | `Caddyfile` |

Где ключи не используются: ключ модели (`ANTHROPIC_API_KEY`) только у фонового процесса; в журналы и в журнал аудита секреты не пишутся (`tests/unit/log.test.ts`, `tests/integration/audit.test.ts`).

## Отклонения

Все требования в состоянии "нет" и "частично": закрыть их кодом сейчас нельзя: нужен сервер, решение владельца или правка ТЗ. Ослаблять правила `CLAUDE.md` ради них не нужно ни в одном случае, кроме V6.2.12 и V16.4.3 (внешний сервис), где решение за владельцем.

| № | Требование | Почему не закрыто | Кто решает |
|---|---|---|---|
| 1 | V12.3.3 (нет), V12.3.1, V13.2.1 | Внутри сервера Caddy, портал, база, ClamAV и TEI общаются без TLS и (ClamAV, TEI) без паролей. Сети Docker разделены, база без выхода наружу (`tests/unit/compose-prod.test.ts`) | Владелец: принять для пилота на одном сервере; TLS к базе при выносе её на отдельный сервер (этап роста аудита) |
| 2 | V6.5.5 | Ссылка входа на почту живёт 15 минут (FR-ID-05), стандарт требует до 10 | Владелец: правка ТЗ, в коде одна константа `LOGIN_LINK_TTL_SEC` |
| 3 | V6.3.3, V6.6.2 | Клиент входит одноразовой ссылкой на почту или в Telegram: один фактор; новая ссылка не отменяет прежние | Владелец: принять для клиентов (вход через Smartup остаётся основным) |
| 4 | V7.3.1, V7.3.2, V7.1.1, V7.1.2 | У сотрудника нет срока бездействия (только 12 часов), сессия клиента продлевается без предела | Владелец: сроки, затем правка FR-ID-10 |
| 5 | V7.5.1, V7.5.2 | Клиент меняет адрес почты и завершает сессии без повторного входа | Владелец: принять или требовать повторный вход |
| 6 | V6.2.12 | Сверки с базой утечек нет, только встроенный список частых паролей | Владелец: внешний сервис (Pwned Passwords по k-анонимности) запрещён правилами без согласования |
| 7 | V10.5.1 | Библиотека входа не посылает nonce | Принять: id_token приходит только из обмена кода с PKCE; проверить при обновлении @better-auth/sso |
| 8 | V14.2.1, V14.3.3 | Токен одноразовой ссылки в адресе письма; черновик обращения в localStorage до отправки или выхода (UX-C-02) | Принято решениями 0016 и 0026; владелец подтверждает |
| 9 | V16.3.2 | Отказ на уровне данных (RLS, ответ 404) не пишется в журнал | Принять: отказ неотличим от неверного номера в адресе |
| 10 | V16.4.3, V16.1.1 | Журналы процессов не уходят в отдельную систему, единого перечня журналов нет | Владелец: сервис сбора журналов (решение 4 плана подготовки); перечень в памятке запуска (задача 8) |
| 11 | V4.1.2, V4.2.1, V3.4.1, V12.1.1, V12.1.2, V12.2.1, V12.2.2, V13.2.4, V13.2.5, V16.4.2 | Проверяются только на сервере: перенаправление https для `/api`, request smuggling, HSTS за Cloudflare, TLS, правила исходящих, доступ к журналам | staging (M9 на сервере) |
| 12 | V11.1.1, V13.3.1, V15.1.1, V15.2.1, V14.1.1, V14.1.2, V14.2.4, V2.1.2, V6.4.4, V7.1.3, V7.6.1, V7.4.5, V13.1.1, V16.3.3 | Документы и решения: политика ключей и хранилище секретов, сроки обновления зависимостей, уровни защиты данных (с юристом), сводка правил согласованности, проверка личности перед сбросом второго фактора, сессии при едином входе, кнопка завершения всех сессий, список внешних узлов, перечень событий безопасности | Владелец и задача 8 подготовки (памятки) |
| 13 | V15.3.6 | Нет проверки линтером на загрязнение прототипа | Задача в следующую веху: правило линтера и тест схем на `__proto__` |
| 14 | V11.2.3 (есть, с шагом) | Длина ключа RS256 сервера Smartup не проверяется | Разработчики Smartup: ключ от 3072 бит или ES256 |
