# Отчёт по вехе M1: личность и изоляция

Дата: 20.11.2026. План: `docs/plans/M1.md` (часть 1, задачи 1-13, и часть 2, задачи 14-22, добавленная по поручению владельца). Ветка: `claude/smartup-customer-portal-iszbit`.

## Итог

Веха готова. Условия строки M1 раздела 16.2 ТЗ выполнены: клиент входит через ложный сервер Smartup и организация создаётся сама, сотрудник не входит без второго фактора, запрос без актора возвращает пусто. Часть 2 тоже готова: пользователь без email привязывает Telegram и входит по ссылке из бота, администратор добавляет сервер Smartup и сотрудника через интерфейс, смена роли видна в журнале аудита. Без ключей внешних сервисов всё остальное работает как прежде. GitHub Actions по-прежнему выключен (решение 0011), все проверки запущены вручную.

## Что сделано

| № | Задача | Результат |
|---|---|---|
| 1 | Зависимости, окружение, шифрование | Better Auth 1.7.22 с SSO и входом по ссылке, схема переменных окружения, запечатанные секреты (`ENCRYPTION_KEY`, AES-256-GCM) |
| 2 | Схема `auth`, роль `hub_auth` | Отдельное подключение для идентичности, `withIdentity` от имени актора, границы слоёв в линтере |
| 3 | Журнал аудита и счётчики | `hdc_audit_log` только с добавлением, автор из переменных актора базы; счётчики частоты в базе |
| 4 | Таблицы идентичности | Серверы, организации, членство, сотрудники, приглашения, подтверждение адреса. Политики для `hub_app` и `hub_auth`, набор изоляции |
| 5 | Экземпляр библиотеки входа | Снаружи открыт один адрес `/api/auth/sso/callback/<сервер>`, остальные отвечают 404 |
| 6 | Сотрудники | Приглашение одноразовой ссылкой, пароль, обязательный TOTP, сессия 12 часов, свежий вход 15 минут для действий администратора |
| 7 | Команда `hub` | `staff:create`, `staff:reset`, `server:add`, `server:list`, `server:disable`, позже `server:check`, `telegram:*`. Секреты в аргументах не принимаются |
| 8 | Вход клиента через Smartup | Ложный сервер OIDC (`scripts/mock-oidc.mjs`), личность "сервер и пользователь", организация создаётся при первом входе, роль по соответствию ролей |
| 9 | Актор клиента | Выбор и переключение организации, защита кабинета на каждом запросе, обновление куки сессии |
| 10 | Email и вход по ссылке | Подтверждение адреса, вход по ссылке (входит только нажатие кнопки), шаг первого входа |
| 11 | Приглашения | Администратор клиента приглашает коллег, отключает и включает участников |
| 12 | Организации в рабочем месте | Поиск, карточка, смена роли участника `care` и `admin` |
| 13 | Сессии | Список своих сессий, завершение одной и всех остальных |
| 14 | Проверка "не робот" | Cloudflare Turnstile за интерфейсом, без ключей выключена |
| 15 | Письма | Отправка через Resend с повторами и ключом идемпотентности |
| 16 | Telegram | Привязка, отвязка, язык, вебхук с секретом и защитой от повторов, ложный Bot API |
| 17 | Запасной вход из бота | Ссылка на 10 минут, одноразовая, вход нажатием кнопки |
| 18 | Настройки и реестр серверов | Раздел только для `admin`, образец "Настройки", реестр с проверкой связи |
| 19 | Сотрудники в настройках | Приглашение письмом, роль, блокировка, сброс второго фактора, правило последнего администратора |
| 20 | Организация и журнал | Категория клиента и AI-обработка на карточке, экран журнала аудита |
| 21 | Гости и политика | Гостевое членство входа не даёт, механизм политики обработки данных, письмо разработчикам Smartup, памятка для staging |
| 22 | Приёмка | Приёмочный тест вехи, полный прогон, независимая проверка, этот отчёт, файл CI |

## Результаты проверок

Прогон после исправлений по итоговой проверке (до них, на коммите `4204873`: модульные 271, с базой 316, браузерные 287 и 108 пропущены, Lighthouse 97 и 100).

| Проверка | Результат |
|---|---|
| `pnpm check` | Нарушений нет. Контраст: все пары не ниже 4,5:1 в обеих темах. Переводы: 3 языка, недостающих ключей нет. Проверки правил ТЗ: нарушений нет |
| Модульные тесты | 276 из 276 (44 файла) |
| Тесты с базой (PostgreSQL 18, pgvector) | 325 из 325 (27 файлов), включая набор изоляции |
| Браузерные тесты, три ширины экрана | 289 прошли, 109 пропущены (сценарии рабочего места идут на ширине ноутбука, кабинета на телефоне и ноутбуке) |
| Скрипты первого экрана клиента | 140 КБ при пределе 170 КБ (`/ru/login` и `/ru` после входа) |
| Lighthouse, мобильный профиль, `/ru/login` | Скорость 99, доступность 100 (пределы 85 и 95) |
| axe, серьёзные и критические замечания | Ноль на страницах входа, ссылок, шага первого входа, выбора организации, организации, профиля, приглашения, подтверждения адреса, настроек рабочего места, на трёх языках и ширине 360 px |
| `pnpm audit --prod` | Уязвимостей нет |

### Критерии готовности

1. Клиент входит через ложный OIDC, организация создаётся сама: `tests/e2e/m1-acceptance.spec.ts`, `client-login.spec.ts`. Выполнено.
2. Сотрудник не входит без второго фактора: тот же приёмочный тест, `staff-login.spec.ts`, интеграционные тесты сотрудников. Выполнено.
3. Запрос без актора возвращает пусто: приёмочный тест и набор изоляции (`tests/integration/isolation/registry.test.ts`) под обеими ролями приложения. Выполнено.

Сквозные сценарии раздела 15.3, которые закрывает веха: 1 (вход и создание организации), 2 (вход по ссылке на email), 21 (запасной вход из бота).

### Набор изоляции

В `DOMAIN_OBJECTS` записан каждый объект схемы `public`: 15 таблиц и представление `hdu_user_profiles`; тест сверяет список с базой. Для каждой таблицы проверено, что видит клиент, что без актора пусто под `hub_app` и `hub_auth`, что `hub_app` не меняет таблицы идентичности, а удалить строку идентичности не может никто. Прямые проверки политик запросами в базу: `identity-direct.test.ts` (в том числе политики раздела "Настройки" из миграции 0007).

## Что нашли проверки по ходу работы

| Находка | Что сделано |
|---|---|
| Шапка после переключения организации показывала прежнюю | Действие читает сессию без кеша и обновляет раскладку |
| Общий адрес "unknown" у всех тестовых входов исчерпывал счётчик | У каждого входа в тестах свой адрес (`withOwnAddress`) |
| Ошибка входа через Smartup уводила на `0.0.0.0` | Адрес строится от `HUB_URL`, тест добавлен |
| Один испорченный секрет сервера ломал любой вход, в том числе сотрудников | Такой сервер пропускается с записью в журнал, тест добавлен |
| Страница организации отвечала 200 вместо 404 из-за `loading.tsx` | Проверка роли перенесена в раскладку раздела |
| Адрес Smartup или сервера входа, уже занятый другим сервером, давал ошибку 500 | Понятная ошибка `server_taken` |
| Собранный портал работает из `.next/standalone` и из `/app` в образе, где не было каталога `content/` | Утверждённая политика никогда бы не включилась. Каталог копируется в образ и при запуске, тест добавлен |
| Порядок журнала аудита по идентификатору ставил записи одной транзакции и записи с другим временем не на место | Порядок по времени записи и идентификатору, курсор составной |
| Тест чужого Origin для серверного действия проходил вхолостую | `route.continue` не подменяет Origin; тест переписан на `route.fetch`, защита Next.js подтверждена |
| Тест первой линии искал "ACME" и не находил "ACME Trade" после 50 прогонов | Другой тест каждый раз заводит "ACME <число>"; поиск уточнён |

## Итоговая независимая проверка ветки

Свежий проверяющий (модель Opus, отдельный контекст) прочитал ветку `c5dd514..4204873` против плана, ТЗ, раздела "На что смотреть при проверке", решений 0012-0019 и всех решений исполнителя. Вердикт: "готово с исправлениями". Сильные стороны по его оценке: двойная защита таблиц идентичности (RLS у обеих ролей, триггеры, нет права удаления), набор изоляции, поиск пользователя только по паре "сервер и идентификатор", ссылки, которые тратит только нажатие, проверка адреса возврата, защита от обращения во внутреннюю сеть.

Найдено: одно критическое, семь важных, двенадцать мелких замечаний. Два мелких я поднял до важных по последствиям. Все критические и важные исправлены одним проходом, каждое начиналось с падающего теста.

| Замечание | Что было | Что сделано |
|---|---|---|
| C1, критическое | Сессия, открытая одним паролем до подключения второго фактора, становилась полной сессией сотрудника, когда второй фактор подключали в другом браузере | Отметка второго фактора на самой сессии (миграция 0008), рабочее место требует её. Решение 0014, пункт 12 |
| I1 | Адрес посетителя брался из первого значения `x-forwarded-for`: за Cloudflare и Caddy это общий адрес узла Cloudflare или подделка | Переменная `CLIENT_IP_HEADER`, в production обязательна. Решение 0020 |
| I2 | Недоступный Smartup или Telegram давал ошибку 500 | Понятные сообщения на странице входа и в профиле, попытка привязки не тратится |
| I3 | Недоступный Turnstile закрывал вход сотрудников по паролю | Нет токена: проверка доступности сервиса; лёг сервис, вход не закрывается |
| I4 | Сбой ответа бота после привязки давал повтор с неверным ответом и терял письмо о привязке | Ответ бота не ломает вебхук, письмо ставится до ответа |
| I5 | Токены сервера Smartup лежали в базе открытым текстом | Не записываются вовсе. Решение 0012 |
| I6 | Форма "Добавить сервер" перезаписывала сервер с тем же кодом | Занятый код отклоняется, команда консоли по-прежнему обновляет |
| I7 | Повторное приглашение сотрудника меняло его роль и пароль без аудита и в обход правила последнего администратора | Приглашение на адрес сотрудника отклоняется, ссылка после сброса роль не меняет. Решение 0014, пункт 13 |
| M8, поднято | Прокси обновлял куку сессии на открытых страницах (ТЗ 18.10, правило 4) | Открытая зона кук не получает |
| M9, поднято | Выключенная задача сборки образа в CI упала бы при включении: нет обязательных секретов | Значения для CI добавлены, тест проверяет |

### Отложенные мелкие замечания

1. Код TOTP можно использовать повторно в пределах его 30 секунд (RFC 6238, 5.2): хранить последний принятый шаг. Вместе с защитой в M8.
2. Счётчик адреса для ссылки входа расходуется и после превышения счётчика IP.
3. Соответствие ролей может найти унаследованное свойство объекта (роль `constructor`).
4. Действующее гостевое членство мешает принять приглашение (станет достижимо в M4).
5. Триггер приглашений позволяет вернуть отозванное приглашение.
6. Короткий шаг о новой редакции политики теряет страницу, куда шёл человек.
7. Страница входа ждёт имя бота до 1,5 секунды на каждом показе, пока Telegram ни разу не ответил.
8. В списке закрытых диапазонов IPv6 нет `2002::/16`, `2001::/32`, `64:ff9b:1::/48`. Более широкий охват ограничения DNS rebinding записан в решении 0019.
9. Проверка набора изоляции "только своя организация" ничего не проверяет у представления `hdu_user_profiles` (его закрывают прямые проверки).
10. После приглашения и сброса сотрудника страница говорит "отправлено", даже если Resend потом отказал.
11. Посетитель с заблокированным виджетом проверки на форме ссылки для входа видит "отправлено" (известное ограничение решения 0018).

## Что отложено

| Что | Почему | Куда |
|---|---|---|
| Очередь писем в одной транзакции с действием, оформленные шаблоны, события доставки | Нужен фоновый процесс (M2) и обращения | M4 |
| Уведомления об обращениях в Telegram, выбор каналов | Обращений ещё нет | M4b |
| Гости из приёма почты, служебная организация "Неопознанные" | Нужен приём почты | M4 |
| Разделы SLA, AI-помощник, почта в "Настройках", токены AI-сотрудников | Нет предмета настройки | M8, M8b |
| Токен контекста и сессия виджета | Нужны страницы виджета и выпуск токена в Smartup | M6 |
| Три подсказки при первом входе | Подсказывать ещё не о чем | M2 |
| Вход через настоящий Smartup | Ждёт регистрации портала как клиента OAuth | staging |
| Мелкие замечания итоговой проверки | Перечень выше | По пунктам |

## Что нужно от владельца для внешних сервисов

| Что | Для чего |
|---|---|
| Учётная запись Cloudflare и два ключа Turnstile для домена | Проверка "не робот" |
| Учётная запись Resend, ключ API, записи DNS почтового поддомена | Письма со ссылками входа и приглашениями |
| Бот Telegram: имя, аватар из пакета бренда, токен от BotFather | Привязка и запасной вход |
| Текст политики обработки данных после проверки юристом, на трёх языках | Показ политики (порядок: `content/legal/README.md`) |
| Регистрация портала как клиента OAuth в Smartup | Вход через настоящий Smartup. Письмо с точными параметрами: `docs/questions.md`, раздел 1, дополнение после M1 |

Порядок развёртывания и проверки staging: `docs/runbooks/staging-after-m1.md`.

## Правки к ТЗ по итогам вехи

Вносятся в ТЗ только после согласия владельца.

1. Таблица вех раздела 16.2: в M1 перешли проверка "не робот" (из M8), отправка писем входа (из M4), личность в Telegram и запасной вход (из M4b), разделы "Настройки" для серверов, сотрудников, организации и журнала аудита (из M8), механизм политики обработки данных (раздел 14.6). Подробно: решение 0017.
2. Раздел 12.2: снаружи у библиотеки входа открыт один адрес, а не `/api/auth/*` (решение 0012).
3. Раздел 14.3 и 10.5: журнал аудита читает администратор через `hub_app`, изменять и удалять его не может никто (решение 0019).
4. Раздел 10.3: политики RLS есть и у роли `hub_auth`, она тоже работает от имени актора (решение 0014).
5. Раздел 11.2: серверы Smartup передаются библиотеке из реестра портала, секрет зашифрован ключом `ENCRYPTION_KEY` (решение 0012).
6. Раздел 10.2: таблица `hdu_server_checks` с итогом последней проверки связи (решение 0019).
7. FR-ADM-03: сброс доступа и блокировку себя и последнего администратора портал не выполняет (решение 0019).
8. Раздел 13: переменная `CLIENT_IP_HEADER` и требование к сетевому экрану (решение 0020).
9. Раздел 14.3: второй фактор проверяется по сессии, а не по учётной записи (решение 0014, пункт 12).

## Решения вехи

| Решение | О чём |
|---|---|
| 0012 | Библиотека входа: один открытый адрес, серверы из реестра, шифрование секретов, адаптер, отключённые резервные коды |
| 0013 | Личность и email: служебный адрес до подтверждения, один подтверждённый адрес на одну учётную запись |
| 0014 | Доступ: `withIdentity`, политики `hub_auth`, свежий вход 15 минут, роли в приглашениях, отключение участника |
| 0015 | Первый сотрудник и команда консоли |
| 0016 | Ссылки и письма: страница с кнопкой, сроки, ответ без раскрытия адреса |
| 0017 | Расширенный состав вехи, гости, политика обработки данных |
| 0018 | Внешние сервисы: Turnstile, Resend, Telegram, язык пользователя, запасной вход из бота |
| 0019 | Раздел "Настройки", реестр серверов, сотрудники, карточка организации, журнал аудита |
| 0020 | Источник адреса посетителя для счётчиков и журнала |

## Решения исполнителя по ходу работы

Каждое отступление от плана и каждое решение, которого план не давал, записывалось строкой в журнале исполнителя. Ниже они собраны дословно (на английском, как записаны), по задачам; строки "Final" относятся к итоговой проверке. Каждая строка: что решено, почему, чего стоит ошибка.

- Task 2: Ruling: hub_auth has no INSERT/UPDATE on auth."ssoProvider" (plan said full DML on all auth tables) - the table must stay empty, providers come from hdu_servers - cost if wrong: a future library version that writes this table fails loudly with permission denied.
- Task 2: Ruling: readiness of both pools lives in src/db/ready.ts (pingDatabases), hdc/api.isDatabaseReady(opts) wraps it - hdc may not import the auth pool by the new lint rule - cost if wrong: none, same behaviour.
- Task 2: Ruling: lint rule "app and ui see a module only through api" also covers hdc/util; routes /api/health and /api/ready now import from @/modules/hdc/api; type-only imports from module internals are allowed; files of the api/ folder count as the api layer (needed by the CLI in task 7) - cost if wrong: a client component cannot import a runtime constant from pref and must get it through props.
- Task 2: Ruling: M0 test "changed migration file stops migrations" now resets the database with helper dropMigratedObjects() instead of dropping two named tables - new migrations made the old cleanup incomplete - assertion unchanged.
- Task 3: Ruling: audit insert policy also requires created_on = now() (backdating is rejected) and the action is checked against the closed list AUDIT_ACTIONS in writeAudit; RATE_RULES got ssoCallbackPerIp {60, 60s} used by the auth route in task 5 - cost if wrong: none.
- Task 4: Ruling: user id comparisons in policies use new function app.user_uuid() (uuid or NULL when the actor id is not a uuid) - a cast of a non-uuid actor id must give "no rows", not an error - cost if wrong: none.
- Task 4: Ruling: extra guards beyond the plan: t_hdu_invitations_guard (a client or staff actor may only set revoked_on), check hdu_servers_c7 (secret column accepts only the sealed format v1.*), check on token_hash format (64 hex), invited_by must equal the acting user on insert, role_map is not readable by hub_app - cost if wrong: tests in later tasks must use sealed-looking secrets and sha256 hashes in fixtures.
- Task 5: Ruling: provider mapping has no "id" key (the plan listed id: 'sub'): the library type OIDCMapping has only email, emailVerified, name, image, extraFields; sub is taken from the verified id_token by the library - cost if wrong: none, verified by reading the installed types.
- Task 5: Ruling: added onAPIError.errorURL = HUB_URL + '/login' - the library error page /api/auth/error is behind the 404 wall, callback errors must land on the portal login page - the login page (task 8) must show a neutral message for any ?error= value.
- Task 5: Ruling: instance.ts exports setAuthHandlers({ sendMagicLink, resolveUser, provisionUser }) instead of hard wiring: tasks 8 and 10 register real handlers; until then mail is dropped and SSO is rejected with code sso_not_connected.
- Task 5: Ruling: hubTrusted throws FORBIDDEN (not 500) when the session hook refuses a session; body.via is limited to TRUSTED_SIGN_IN_WAYS.
- Task 6: Ruling: RequestInfo.setCookies takes the response Headers (plan said string lines): it mirrors how the library plugin copies cookies, parseSetCookieHeader + toCookieOptions from better-auth/cookies exist and are used in nextRequest().
- Task 6: Ruling: api functions that need Next.js (requireStaffActor etc.) live in api/actor.ts, pure ones (resolveStaff) in api/session.ts - integration tests must not import next/headers.
- Task 6: Ruling: new error code sign_in_expired (password step missing or older than 10 minutes); staff reset is ONE transaction inside createStaffInvitation(actor, input, { resetUserId }).
- Task 6: Ruling: form error texts are translated in the server action and returned as ready strings (state.error): client forms carry no message tables and ICU plurals work.
- Task 6: Ruling: AgentShell takes a userMenu slot (ReactNode) built by the (agent) layout - ui must not import app server actions; the showcase uses AgentShell without it, snapshots unchanged.
- Task 6: Ruling: e2e staff come from the Playwright project "setup" (tests/e2e/staff.setup.ts): invitation row inserted with a hashed token through tests/e2e/helpers/db.ts (superuser), then accept + enroll through the UI; storage states in tests/e2e/.auth/{care,l1,admin}.json, credentials in staff.json. Task 7 switches the invitation to the hub command.
- Task 6: Ruling: the plan's e2e step "short password shows a server error" is replaced by "mismatched passwords show the server error" plus a check of minlength=12 - the browser blocks a short password before the server sees it.
- Task 7: Ruling: DNS names that do not resolve are rejected (fail closed); tests inject a resolver with setDnsResolverForTests() because *.example never resolves.
- Task 7: Ruling: node:net BlockList checks IPv4 addresses against IPv6 rules too (::ffff:0:0/96 blocked every IPv4): two separate lists.
- Task 7: Ruling: server:add on an existing code updates details but keeps the state; enabling a disabled server is enableServer in task 18. Audit action server.enabled added to the closed list.
- Task 7: Ruling: createTrustedSession moved to core/trusted.ts (core/sessions must stay free of the auth library: it is part of the CLI bundle). CLI imports only hdu api/staff-admin, api/servers, api/errors, api/connections.
- Task 7: Ruling: lint DB pattern allows type-only imports (actor types are used outside src/db).
- Task 8: Ruling: the "Sign in with Smartup" button is a link to a GET route handler /{locale}/login/smartup (plan: server action) - a form submission redirecting to the Smartup origin would be blocked by CSP form-action 'self' once enforcing (M9). Added RATE_RULES.ssoStartPerIp {30, 600 s}; startSmartupSignIn may return { error: 'rate_limited' }.
- Task 8: Ruling: the claim key for the real email is contactEmail (plan: email) - the library fills userInfo.email with sub because mapping.email = 'sub'.
- Task 8: Ruling: smartupProfile lives in core/claims.ts (pure, unit tested); resolveSmartupUser uses the library transaction adapter (findOne/create from context.database), not withIdentity, so a failed sign-in leaves no orphan user. Membership role change by role_map writes member.role_changed with source smartup.
- Task 8: Ruling: instance.ts wires resolveUser/provisionUser directly (DEFAULT_HANDLERS); setAuthHandlers stays for the mail handler of task 10.
- Task 8: Ruling: login page is server-rendered only (no client JS): "own server" is ?mode=server, remember/forget are form actions redirecting back. Support address not shown yet (comes with settings).
- Task 9: Ruling: activeOrgId and lastOrgId are written by a direct update of auth.session/auth.user under withIdentity(system, job identity.actor) in core/orgs.ts (brief: internalAdapter.updateSession) - core stays free of the auth library, there is no cookie cache, so the next getSession reads the new value. Cost if wrong: a future library cookie cache would need invalidation here.
- Task 9: Ruling: pure functions (resolveClient, listMyOrganizations, switchOrganization) live in api/orgs.ts; Next.js gates (requireClientActor, requireSignedInClient, switchOrganizationOfRequest) in api/actor.ts. signOutAction lives in src/app/[locale]/session-actions.ts (shared by portal and gate) instead of (portal)/actions.ts.
- Task 9: Ruling: the switch action reads the session uncached (React cache would hand the redirect render a pre-switch snapshot) and calls refresh() from next/cache before redirect (layouts are not re-rendered on navigation, the header kept the old org). Found by the e2e switch test.
- Task 9: Ruling: phone header (320-599 px): single org name is sr-only, several orgs show an icon button that opens the switcher, "Hub" next to the logo is sr-only in the portal shell. No room for the name next to language, theme and user menu at 44 px targets.
- Task 9: Ruling: UserMenu is lazy like LanguageSwitcher (UserMenuContent loads on first use), agent shell included - keeps the portal home at 150 KB of 170.
- Task 9: Ruling: pnpm budget and Lighthouse measure /ru/login (the portal home redirects visitors there); tests/e2e/budget.spec.ts measures the signed-in /ru on phone with the shared budget-rules.mjs (Playwright cannot load a file with import.meta). Budget script loads .env like lighthouse-server.
- Task 9: Ruling: e2e client sign-ins send their own x-forwarded-for from 198.18.0.0/15 (withOwnAddress): all tests shared one rate-limit key and exhausted 30 SSO starts / 10 min, and 20 server lookups / hour, on repeated runs.
- Task 9: Ruling: fixed a task 8 bug - /login/smartup error redirect was built from request.nextUrl (0.0.0.0 in standalone); now from HUB_URL, e2e test added (RED with 0.0.0.0, GREEN after).
- Task 9: Ruling: proxy refresh also extends staff cookies to 30 days; harmless because the DB session of staff still ends after 12 h. Refresh only on GET, value echoed byte for byte, only token-safe characters.
- Task 9: Ruling: the "Организация" user-menu link is left to task 11 (its page appears there); the settings page text stays until task 10 rewrites the page.
- Task 9: Ruling: select-organization uses a plain bordered button instead of Button: Button has a fixed height (h-control wins over h-auto) and clipped two-line content.
- Task 10: Ruling: e2e scenarios use a fresh Smartup user and address per test and run (uniqueSub) instead of personas dilnoza/alisher: shared personas are onboarded by the setup project and get a confirmed address on the first run, so a rerun on the same DB would skip the step.
- Task 10: Ruling: ClientContext.user gained email (confirmed, else null) and claimedEmail: the welcome step and the profile need them.
- Task 10: Ruling: requestLoginLink takes Pick<RequestInfo,'headers'>; a malformed address gets the same answer; the IP counter is consumed for every request, the address counter for every well-formed address.
- Task 10: Ruling: the library writes the hashed link token before the answer (one insert), only mail delivery is detached (queueMail). Cost if wrong: a timing difference of one insert between eligible and other addresses.
- Task 10: Ruling: the mail carries the portal page /{locale}/login/link built from the library token in auth/mail.ts; locale and next travel in the library's metadata. The library error class is a different instance: isAPIError from better-auth/api, not instanceof.
- Task 10: Ruling: /welcome requires the client actor (no organization goes to the no-organization screen); the "sent" message does not echo the address (the per-request cache would show the value before the update).
- Task 10: Ruling: email_taken spends the token; confirmation does not need a session and runs as system. Added messages auth.confirmEmail (brief listed auth.link and auth.welcome); removed the stale client.profile empty state from the settings page.
- Task 10: Ruling: SSO callback is /{locale}/welcome?next=<safe path>; the task 8 integration test now checks the welcome hop and the safe next.
- Task 11: Ruling: listSsoServers skips a server whose secret no longer decrypts (log line with the code, no secret) instead of throwing - seedTwoOrgs' fake sealed secret exposed that one bad row stops every sign-in, staff included. Test in servers.test.ts. Cost if wrong: a misconfigured server silently disappears from sign-in (the log names it).
- Task 11: Ruling: OrgScope resolution lives in api/scope.ts (manageScope): client admin of the actor's org, care/admin with a validated orgId; listing members and invitations needs the same rights (a client_user gets forbidden).
- Task 11: Ruling: accepting creates the user with emailVerified=true; a missing or invalid name falls back to the address local part; an already active member just marks the invitation accepted; membership source is staff when the inviter is in hdu_staff.
- Task 11: Ruling: /org role check sits in org/layout.tsx too: with loading.tsx the page streams and notFound() inside answered 200. Disable confirmation is a GET form (?confirm=<userId>) on the same page, no client JS. No error.tsx: client components have no message tables; action errors come back as alerts.
- Task 11: Ruling: e2e uses a fresh company per test with a director role (role map gives client_admin) instead of persona dilnoza: the 20 invitations per hour per organization limit and shared rows would make reruns flaky.
- Task 11: Ruling: action buttons in the org tables use the default size (client zone targets are 44 px, small is 36 px).
- Task 12: Ruling: viewing organizations and members is open to every human staff role (requireHumanStaff in api/scope.ts); invitations on the card are listed and managed only by care and admin (manageScope), l1 sees members read-only.
- Task 12: Ruling: member emails for staff come from auth.user through withIdentity(system 'identity.staff-view') by the listed user ids: hub_app has no access to schema auth. Synthetic addresses are never shown.
- Task 12: Ruling: a stale sign-in on role change returns ?error=stale_session with a "Войти заново" link to /staff/login?reauth=1&next=<card> instead of redirecting at once (brief: the page offers to sign in again). E2E ages the test's own session row by 20 minutes, not the shared care session.
- Task 12: Ruling: e2e uses a fresh client company per test and the saved l1 session (l1 sign-ins are counted by the staff audit test); the brief's persona timur would not exist on a clean database.
- Task 13: Ruling: listMySessions returns { items, hidden }: at most 20 sessions (current first), plus revokeOtherSessions and an "End all other sessions" button (not in the brief) - the e2e persona showed 125 sessions on one page, and older sessions of a lost device could not be reached otherwise. Staff audit for it: session.revoked on the user with diff { others }.
- Task 13: Ruling: page data comes from mySessions() and actions use revokeMySessionOfRequest()/revokeOtherSessionsOfRequest() in api/actor.ts (actions read the session uncached). Shared formatting in src/app/[locale]/sessions-view.ts.
- Task 13: Ruling: e2e uses a fresh Smartup user per run instead of persona alisher: ending "another" alisher session would end the shared client storage state.
- Task 14: Ruling: Turnstile API verified with the Cloudflare docs connector (developers.cloudflare.com is blocked by the session network): siteverify fields secret/response/remoteip, token <= 2048 chars, 5 minutes, single use; unsupported widget language falls back to English.
- Task 14: Ruling: the check runs first in all three actions (brief required it only for staff) - robots must not consume the per-address link counter or the server lookup counter either.
- Task 14: Ruling: added BotCheckRefresh (not in the brief): tokens are single use, so after any form answer the widget is reset (keyed by the page nonce for server forms and by the action state for the staff form); otherwise a mistyped password could not be retried without a reload. Not covered by automated tests (no keys in e2e) - to check on staging with Cloudflare test keys.
- Task 14: Ruling: rememberServer takes botToken as a third argument (it has no input object).
- Task 15: Ruling: Resend docs could not be read (resend.com blocked by the session network, no connector): request fields and the Idempotency-Key header follow the known Resend API; 0018 asks for one real send on staging before the key goes live. Cost if wrong: the first real mail fails with 4xx, visible in the log by kind and status.
- Task 15: Ruling: each attempt has its own 5 s limit raced against the fetch (a fetch that ignores the abort signal still times out); MailError message holds only the status.
- Task 16: Ruling: handleTelegramWebhook(request, onUpdate) takes the update handler as a parameter (the route wires hdu.handleTelegramUpdate): hdn must not import hdu while hdu imports hdn for mail and the bot.
- Task 16: Ruling: the webhook secret lives in the bot object (checkSecret) together with the token; MemoryTelegramBot carries a fixed SECRET for tests. Added answerCallback (answerCallbackQuery) to the interface so buttons do not keep spinning.
- Task 16: Ruling: "Привязать Telegram" is a GET route handler /{locale}/settings/telegram that redirects to t.me (form submissions may not leave the portal under form-action 'self'), opened in a new tab; the page keeps its state. Client gets an UPDATE policy on own hdu_link_codes to cancel earlier codes in the same transaction.
- Task 16: Ruling: registry access class own-user added for hdu_contact_identities; staff see links via hub_app (is_internal), codes are visible to nobody through hub_app.
- Task 16: Ruling: Telegram API docs unreachable from the sandbox (same network limit); fields follow the known Bot API, 0018 asks for a real link test on staging. CLI uses hdn/api/telegram-admin.ts so the bundle does not pull mail texts.
- Task 16: Ruling: the bot's "Войти" button sends callback 'login' and answers with the portal link until task 17 adds the sign-in link.
- Task 17: Ruling: the bot link counter is keyed by Telegram account id (telegram-login:account), not by portal user - the bot is the only caller and the account id is what an attacker controls.
- Task 17: Ruling: eligibility (linked, not blocked, not staff, active non-guest membership in active org) is re-checked inside the consuming transaction; the code is spent even when the re-check fails, so a revoked link cannot be retried later.
- Task 17: Ruling: login page waits at most 1.5 s for the bot name (getMe is cached after the first success); no bot line if Telegram is slow or down.
- Task 18: Ruling: hdu_invitations admin policy for staff invitations already exists in 0005 (select/insert/update); 0007 does not add a duplicate.
- Task 18: Ruling: the last check result lives in a new table hdu_server_checks (RLS, isolation row, stamp columns), not in hdu_servers: any hdu_servers update bumps modified_on and rebuilds the auth instance via registryStamp, while a check must change nothing.
- Task 18: Ruling: hdu_organizations care/admin update needs a matching hub_auth SELECT policy (UPDATE with WHERE needs row visibility); the isolation test that expected 0 rows for care renaming an org now expects the guard trigger error - still denied, stronger.
- Task 18: Ruling: audit.test.ts "app never reads the log" rewritten per decision table item 20: admin reads via hub_app, all other actors see nothing, hub_auth denied, update/delete/truncate denied for everyone.
- Task 18: Ruling: write functions (addServer, disableServer, updateServer, enableServer) take SystemActor or StaffContext, not a bare StaffActor, so freshness cannot be bypassed; existing tests pass staffCtx(...).
- Task 18: Ruling: new HduError code server_taken for a Smartup or issuer address already used by another server (was a 500 on unique violation).
- Task 18: Ruling: e2e uses a third mock issuer mock-spare on 3193 (not 3191): 3191 is registered as mock-dedicated and base_url/issuer are unique. After adding, the card opens (callback address and check button) instead of the list; disabling asks for confirmation first.
- Task 18: Ruling: known limitation in 0019 - DNS can re-resolve between assertPublicUrl and fetch (rebinding); closing it needs a custom resolver in the HTTP client, no new dependencies in M1.
- Task 19: Ruling: web functions live in api/staff-manage.ts, not api/staff-admin.ts - staff-admin.ts is bundled into the CLI and must not pull mail texts (next-intl and messages).
- Task 19: Ruling: Mailer gets a delivers flag (false only for none) and hdn exposes mailDelivers(); mailSent reports it. STAFF_INVITATION_TTL_SEC moved to hdu/pref.ts so a unit test ties the mail text hours to it.
- Task 19: Ruling: blocked staff are already refused a session by the session create hook (auth/hooks.ts) at both password and code steps; no duplicate check added, the tests cover it.
- Task 19: Ruling: self reset is forbidden like self block and self demotion (the admin would lose access); agent_bot rows are hidden and return not_found.
- Task 19: Ruling: the row has one "Управлять" button that opens a staff card above the table (role form, block or unblock, reset); three buttons per row made rows three times taller. "Пригласить сотрудника" is a link (?invite=1), not a button, so the page works without scripts.
- Task 19: Ruling: the e2e block test creates its own staff member via hub staff:create and the setup page; blocking the shared l1 account would break other specs.
- Task 20: Ruling: listAudit lives in hdc and takes { actor } structurally (StaffContext fits) - hdc must not import hdu; names come from hdu_user_profiles and hdu_organizations by SQL subquery with fully qualified outer columns. New HdcError (forbidden, invalid_input) in hdc/error.ts.
- Task 20: Ruling: audit order is created_on desc, audit_id desc with a compound cursor resolved from the last audit_id; the brief's audit_id-only order put backdated or same-transaction rows in the wrong place.
- Task 20: Ruling: the brief's two audit tests ("only admin reads", "nobody changes or deletes") were already folded into task 18's rewritten audit test; task 20 adds paging, filters, names and the 7-day default.
- Task 20: Ruling: author and organization filters are links from rows (plus a link from the org card for admin), not free-text id inputs; the e2e checks org.updated written by care instead of member.role_changed so the test owns its data.
- Task 20: Ruling: organizations.spec l1 search narrowed to "ACME Trade" - portal-access.spec adds an "ACME <n>" organization every run and after 50 runs the shared org fell off page 1 (pre-existing data accumulation, not a behaviour change).
- Task 21: Ruling: guest exclusion sits in loadClientAccess (covers resolveClient, listMyOrganizations, switchOrganization) and isLoginLinkRecipient; the bot login already excluded guests in task 17.
- Task 21: Ruling: policy versions are dates (YYYY-MM-DD, POLICY_VERSION_PATTERN) so a manifest value cannot carry anything else into the user record; acknowledgePolicy rejects other values.
- Task 21: Ruling: the short "policy updated" step is also triggered from the portal layout (not only after Smartup sign-in, which is the only path through /welcome), so email-link and bot sign-ins see a new version too. Welcome actions record the version the user saw.
- Task 21: Ruling: the (public) lint rule repeats the general restrictions because a later flat-config rule replaces, not merges, no-restricted-imports.
- Task 21: Ruling: found by a manual smoke with a temporary manifest: the built portal runs from .next/standalone (and /app in Docker) where content/ was missing, so an approved policy would never switch on. Dockerfile copies content, start-standalone.mjs refreshes the copy (removing stale files); unit test legal-files.test.ts pins both.
- Final: Ruling: re-graded M8 (proxy refreshes the session cookie on (public) pages) to important - TZ 18.10 rule 4 says public responses set no cookies; with Cloudflare caching a response could carry one person's cookie - cost if wrong: a small extra change.
- Final: Ruling: re-graded M9 (disabled CI image job lacks BETTER_AUTH_SECRET and ENCRYPTION_KEY) to important - task 22 delivers the CI file; it would fail on the day it is enabled.
- Final: Ruling: declined items stand as set aside by the reviewer - staff lockout and per-address link limits (TZ 14.5), mailbox control equals sign-in (0013), first password holder enrols TOTP (0015), single visitor with blocked Cloudflare (0018), mail without a queue (0018), Resend/Telegram field correctness (staging check), unaudited client session revocation (task 13), Telegram is_blocked and my_chat_member (M4b), cleanup jobs (M2), company_id meaning (question 43), no org disable UI (not in plan), GET side effects on /settings/telegram and /login/smartup (no exploit found), translations and visuals (reviewed by screenshots), report draft (outside range) - cost if wrong: each is a known, recorded limitation.
- Final: Ruling: bot-check failure on the login-link form still answers "sent" for a single visitor whose widget is blocked (reviewer suggestion in I3) - the outage case is now unavailable and proceeds; changing the form contract is a UX change for M8 together with M12 wording - cost if wrong: that visitor waits for a mail that does not come and retries.

## Дополнение 21.11.2026: после проверки main

После слияния в `main` прошли две независимые проверки. По решению владельца исправлено всё найденное, вместе с отложенными мелкими замечаниями этого отчёта: план `M1-hardening.md`, итог `M1-hardening-report.md`. Что в этом отчёте устарело:

- Отложенные мелкие замечания 1-10 исправлены (S11, Q2, Q22 плана доработки). Замечание 11 остаётся известным ограничением решения 0018.
- Письмо разработчикам Smartup (`docs/questions.md`, раздел 1) уточнено: `id_token` обязателен, адрес userinfo нет, поля с типами и обязательностью.
- Памятка staging переписана под команды, которые работают в образе (`node hub.mjs`, `node scripts/db/migrate.mjs`), добавлены `compose.prod.yaml` и `Caddyfile`.
- Пределы частоты из раздела "Решения вехи" пересмотрены (решение 0014, пункт 9).
