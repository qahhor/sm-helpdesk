import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { SystemActor } from '@/db/with-actor';
import { addServer, checkServer, disableServer, getServer, listServers, resealServerSecrets, type ServerIssue, updateWidgetSettings } from '@/modules/hdu/api/servers';
import { adminActorByEmail, adminContextByEmail, inviteStaff, resetStaff } from '@/modules/hdu/api/staff-admin';
import { runSeedPilot } from './seed-pilot';
import { revokeSessions } from '@/modules/hdu/api/sessions-admin';
import { isHduError } from '@/modules/hdu/api/errors';
import { setTelegramWebhook, telegramInfo } from '@/modules/hdn/api/telegram-admin';
import { cleanupInbound, cleanupOutbox, cleanupTelegramUpdates, resealChannelSecrets } from '@/modules/hdn/api/maintenance';
import { cleanupAuthRows } from '@/modules/hdu/api/maintenance';
import { BACKUP_KINDS, type BackupKind, cleanupRateLimits, markHost, getSearchWriter, issueSearchKeys, markBackup, prepareSearchIndex, reindexCollection, SEARCH_COLLECTIONS, type SearchCollection, searchQueueState, SearchWriteError } from '@/modules/hdc/api';
import { registerSearch } from '@/worker/search';
import { resealWebhookSecrets } from '@/modules/hdw/api/webhook-jobs';
import { importModules } from '@/modules/hdr/api/import';
import { type CorpusEntry, groupCorpus, parseCorpus } from '@/modules/hdk/api/signatures';
import { runIdeaCycle } from '@/modules/hdi/api/cycle-job';

// Команда hub для консоли сервера (FR-ID-12, решение 0015): первый администратор, сброс доступа
// сотрудника, реестр серверов Smartup, проверка правил сигнатур ошибок на корпусе (план M5, задача 8). Работает от актора system, каждое изменение пишется в журнал аудита.
// Пароли и секреты в аргументах не принимаются: аргументы видны в списке процессов и в истории оболочки.

export type CliIo = {
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** Ввод секрета без отображения на экране. */
  readSecret(prompt: string): Promise<string>;
};

const ACTOR: SystemActor = { type: 'system', job: 'cli' };

const HELP = `Использование: hub <команда> [ключи]

  staff:create --email <адрес> --name <имя> --role <роль> [--lead]
      Пригласить сотрудника. Печатает одноразовую ссылку на 24 часа: по ней сотрудник задаёт пароль
      и подключает второй фактор. Роли: agent_l1, agent_l2, care, product, admin.

  staff:reset --email <адрес>
      Сбросить доступ сотрудника: пароль и второй фактор удаляются, все сессии завершаются.
      Печатает новую ссылку.

  server:add --code <код> --name <название> --base-url <адрес Smartup> --issuer <адрес сервера входа>
             --client-id <идентификатор клиента> [--default] [--role-map <json>] [--endpoints <json>]
      Добавить сервер Smartup или обновить сервер с тем же кодом. Секрет клиента OAuth берётся
      из переменной HUB_OAUTH_CLIENT_SECRET, иначе спрашивается без отображения на экране.
      --role-map: соответствие ролей, например {"director":"client_admin"}.
      --endpoints: адреса без документа discovery: {"authorization":..., "token":..., "userinfo":..., "jwks":...}.

  server:list
      Список серверов Smartup.

  server:disable --code <код>
      Отключить сервер: вход через него закрывается.

  server:widget --code <код> --key-mode <jwks|secret> [--jwks-url <адрес ключей>] [--embed-origins <адрес,адрес>]
      Настройки виджета сервера (план M6): режим подписи токена контекста, адрес открытых ключей (режим jwks)
      и дополнительные адреса, которым можно встраивать виджет. Печатает ключ встраивания. Режим secret
      при первом включении печатает общий секрет один раз: его передают разработчикам Smartup.

  server:check --code <код>
      Проверить связь с сервером: документ discovery, адреса входа, ключи и PKCE S256.
      Код завершения 1, если найдены проблемы.

  telegram:set-webhook
      Поставить вебхук бота Telegram на адрес портала (HUB_URL/api/webhooks/telegram) с секретом
      из TELEGRAM_WEBHOOK_SECRET. Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET.

  telegram:info
      Включён ли бот и его имя в Telegram.

  modules:import --file <путь> --admin <адрес>
      Загрузить справочник модулей из выгрузки Smartup (JSON: code, parentCode, name {ru, uz, en}, screens).
      Справочник меняет только администратор портала: загрузка идёт от имени действующего администратора
      с этим адресом, журнал аудита называет его. Модули добавляются и обновляются по коду, отсутствующие
      в файле скрываются. При ошибке справочник не меняется, команда называет запись и строку файла.

  seed:pilot --file <путь> --admin <адрес> [--dry-run]
      Начальные данные пилота одним файлом JSON (план подготовки M9, задача 6; пример docs/pilot/seed.example.json):
      справочник модулей, праздники, сроки SLA и календарь, шаблоны ответов, памятки первой линии, теги, подсчёт
      голосов за идеи, приглашения сотрудников письмом, черновики решений. Запись идёт от имени действующего
      администратора с этим адресом и только там, где база отличается от файла: повторный запуск ничего не меняет.
      Данных клиентов файл не принимает, решения не публикуются. --dry-run: показать изменения, ничего не записывая.
      Весь файл проверяется до первой записи: ошибка проверки ничего не меняет, команда называет раздел и запись.
      Если модуль портала отказал посреди записи, уже записанное остаётся: повторный запуск допишет остальное.

  signatures:test [--dir <каталог>]
      Проверить правила сигнатур ошибок (ТЗ 11.5) на корпусе текстов: файлы *.txt каталога, записи через пустую
      строку, строки с # пропускаются, метка ожидаемой группы в начале записи: [метка]. По умолчанию каталог
      tests/fixtures/errors. Печатает группы "сигнатура: тексты" и сводку. База не нужна.
      Код завершения 1, если одна метка распалась на несколько сигнатур или в одну сигнатуру попали разные метки.

  ideas:cycle --month <ГГГГ-ММ>
      Отбор идеи месяца за этот месяц (план M7, задача 9), как его делает задание 1-го числа в 09:00 по Ташкенту:
      прошлый невыбранный отбор закрывается, пятёрка лидеров по голосам переходит в шорт-лист, роль product
      получает уведомление. Повторный запуск за тот же месяц ничего не меняет. Для проверки и ручного запуска.

  ops:backup-mark --kind <dump|base> [--bytes <размер>]
      Отметить удачную резервную копию (план подготовки M9, задача 3): dump - ночная копия backup.sh, base - базовая
      копия base-backup.sh. Сценарии вызывают команду сами после выгрузки. По возрасту отметок фоновый процесс шлёт
      дежурным сигнал backup_stale. --bytes: размер зашифрованного файла копии.

  sessions:revoke --user <адрес> | --staff | --all
      Завершить сессии при инциденте (план M9, решение 9): одного пользователя по адресу, всех сотрудников или
      всех. Вход потребуется заново. Пишет session.revoked_bulk в журнал аудита: охват и число, без адресов.

  ops:host-mark --host <имя> --disk <п> --mem <п> --cpu <п>
      Отметить ресурсы сервера (план M9, решение 17): доли занятого диска томов базы и копий, памяти и процессора,
      целые от 0 до 100. Вызывает сценарий scripts/ops/host-watch.sh по таймеру раз в 5 минут. По отметкам фоновый
      процесс шлёт дежурным сигналы host_pressure (80% и выше) и host_mark_stale (отметок нет 15 минут).
      --host: имя сервера, обязательно: имя машины внутри контейнера меняется при каждом пересоздании.

  maintenance:cleanup
      Удалить просроченные служебные строки: счётчики частоты, номера событий Telegram, сессии
      и одноразовые значения входа. Запускать раз в сутки, пока нет фоновых задач (решение 0023).

  secrets:reseal
      Замена ключа шифрования: перешифровать сохранённые секреты (серверы Smartup, бот дежурных, вебхуки) ключом
      из ENCRYPTION_KEY. Прежний ключ на время замены задаётся в ENCRYPTION_KEY_PREVIOUS.
      Код завершения 1, если какой-то секрет не открылся ни одним ключом.

  search:keys [--rotate]
      Ключи Typesense для портала и фонового процесса (план W6, решение 3): ключ поиска клиента, ключ поиска
      сотрудника и ключ записи. Главный ключ берётся из TYPESENSE_API_KEY, иначе спрашивается без отображения;
      адрес из TYPESENSE_URL. Ключи печатаются один раз. --rotate: прежние ключи портала удаляются, ключи с
      областью от них перестают действовать сразу.

  search:reindex [--collection <коллекция>]
      Построить индекс поиска заново (план W6, решение 12): новая версия коллекции пачками, переключение
      псевдонима, сверка. Без ключа все коллекции. Коллекции: tickets, ticket_texts, solutions, ideas, orgs, people.
      Нужны SEARCH_PROVIDER=typesense, TYPESENSE_URL и TYPESENSE_WRITE_KEY (запуск в контейнере worker).

  search:status
      Состояние поиска: документы каждой коллекции, очередь записи, память Typesense.

  --help
      Эта справка.`;

type Options = Record<string, { type: 'string' | 'boolean' }>;

const COMMANDS: Record<string, { options: Options; required: string[] }> = {
  'staff:create': {
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, lead: { type: 'boolean' } },
    required: ['email', 'name', 'role'],
  },
  'staff:reset': { options: { email: { type: 'string' } }, required: ['email'] },
  'server:add': {
    options: {
      code: { type: 'string' },
      name: { type: 'string' },
      'base-url': { type: 'string' },
      issuer: { type: 'string' },
      'client-id': { type: 'string' },
      default: { type: 'boolean' },
      'role-map': { type: 'string' },
      endpoints: { type: 'string' },
    },
    required: ['code', 'name', 'base-url', 'issuer', 'client-id'],
  },
  'server:list': { options: {}, required: [] },
  'server:disable': { options: { code: { type: 'string' } }, required: ['code'] },
  'server:check': { options: { code: { type: 'string' } }, required: ['code'] },
  'server:widget': {
    options: { code: { type: 'string' }, 'key-mode': { type: 'string' }, 'jwks-url': { type: 'string' }, 'embed-origins': { type: 'string' } },
    required: ['code', 'key-mode'],
  },
  'telegram:set-webhook': { options: {}, required: [] },
  'telegram:info': { options: {}, required: [] },
  'maintenance:cleanup': { options: {}, required: [] },
  'sessions:revoke': { options: { user: { type: 'string' }, staff: { type: 'boolean' }, all: { type: 'boolean' } }, required: [] },
  'ops:backup-mark': { options: { kind: { type: 'string' }, bytes: { type: 'string' } }, required: ['kind'] },
  'ops:host-mark': { options: { disk: { type: 'string' }, mem: { type: 'string' }, cpu: { type: 'string' }, host: { type: 'string' } }, required: ['host', 'disk', 'mem', 'cpu'] },
  'ideas:cycle': { options: { month: { type: 'string' } }, required: ['month'] },
  'secrets:reseal': { options: {}, required: [] },
  'modules:import': { options: { file: { type: 'string' }, admin: { type: 'string' } }, required: ['file', 'admin'] },
  'signatures:test': { options: { dir: { type: 'string' } }, required: [] },
  'search:keys': { options: { rotate: { type: 'boolean' } }, required: [] },
  'search:reindex': { options: { collection: { type: 'string' } }, required: [] },
  'search:status': { options: {}, required: [] },
  'seed:pilot': { options: { file: { type: 'string' }, admin: { type: 'string' }, 'dry-run': { type: 'boolean' } }, required: ['file', 'admin'] },
};

/** Каталог корпуса сигнатур по умолчанию (план M5, задача 8). */
const CORPUS_DIR = 'tests/fixtures/errors';
/** Сколько знаков текста печатается в строке группы. */
const CORPUS_LINE_MAX = 160;

const corpusLine = (entry: CorpusEntry) => {
  const first = entry.text.split('\n')[0] ?? '';
  const text = first.length > CORPUS_LINE_MAX ? `${first.slice(0, CORPUS_LINE_MAX)}...` : first;
  return `    ${entry.label ? `[${entry.label}] ` : ''}${text}`;
};

/** Группы корпуса и сводка. Код 1: метки распались или смешались. */
async function signaturesTest(dir: string, io: CliIo): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.txt')).sort();
  } catch {
    io.err(`Каталог не прочитан: ${dir}`);
    return 1;
  }
  const entries: CorpusEntry[] = [];
  for (const name of files) entries.push(...parseCorpus(await readFile(join(dir, name), 'utf8')));
  const report = groupCorpus(entries);
  io.out(`Корпус ${dir}: файлов ${files.length}, текстов ${report.total}.`);
  report.groups.forEach((group, index) => {
    io.out('');
    io.out(`Группа ${index + 1}, сигнатура ${group.signature}: ${group.code || 'без кода'} | ${group.message || 'без текста'}`);
    io.out(`  текстов ${group.texts.length}${group.labels.length > 0 ? `, метки: ${group.labels.join(', ')}` : ''}`);
    for (const entry of group.texts) io.out(corpusLine(entry));
  });
  if (report.unrecognized.length > 0) {
    io.out('');
    io.out(`Без сигнатуры (строка ошибки не найдена): ${report.unrecognized.length}`);
    for (const entry of report.unrecognized) io.out(corpusLine(entry));
  }
  io.out('');
  io.out(`Итог: текстов ${report.total}, групп ${report.groups.length}, без сигнатуры ${report.unrecognized.length}.`);
  if (report.splitLabels.length > 0) io.out(`Одна ошибка дала несколько сигнатур, метки: ${report.splitLabels.join(', ')}.`);
  if (report.mixedGroups.length > 0) io.out(`Разные ошибки дали одну сигнатуру: ${report.mixedGroups.join(', ')}.`);
  if (report.splitLabels.length === 0 && report.mixedGroups.length === 0) io.out('Метки и сигнатуры совпадают.');
  return report.splitLabels.length > 0 || report.mixedGroups.length > 0 ? 1 : 0;
}

class UsageError extends Error {}

function parseJson(name: string, text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`--${name}: ожидается JSON`);
  }
}

const ERROR_TEXT: Record<string, string> = {
  invalid_input: 'Проверьте значения: адрес, роль, код сервера или адреса сервера входа. Адреса сервера: только https и только внешние узлы.',
  not_found: 'Сотрудник или сервер не найден.',
  forbidden: 'Нет прав на это действие.',
  email_taken: 'Адрес занят другой учётной записью.',
  already_member: 'Этот адрес уже у сотрудника. Роль меняется в рабочем месте, доступ восстанавливает staff:reset.',
  server_taken: 'Адрес Smartup или адрес сервера входа уже записан у другого сервера.',
};

/** Проблемы проверки связи понятными строками (те же, что на странице сервера). */
const ISSUE_TEXT: Record<ServerIssue, string> = {
  unreachable: 'Сервер не отвечает или ответил ошибкой.',
  timeout: 'Сервер не ответил за 5 секунд.',
  not_json: 'Сервер ответил не документом JSON.',
  issuer_mismatch: 'Адрес сервера входа в документе не совпадает с адресом в реестре.',
  no_authorization_endpoint: 'В документе нет адреса авторизации.',
  no_token_endpoint: 'В документе нет адреса токена.',
  no_userinfo_endpoint: 'В документе нет адреса сведений о пользователе.',
  no_jwks: 'Нет адреса ключей или ключи не отдаются.',
  no_pkce_s256: 'Сервер не поддерживает PKCE S256.',
};

/** Названия секретов каналов для вывода команды. */
const CHANNEL_SECRET_NAMES: Record<string, string> = { oncall_telegram_bot: 'бот дежурных' };

function linkLines(env: CliIo['env'], result: { token: string; expiresOn: Date }): string[] {
  return [
    `Ссылка: ${env.HUB_URL ?? ''}/ru/staff/setup?token=${result.token}`,
    `Действует до: ${result.expiresOn.toISOString()}`,
    'Передайте ссылку сотруднику лично. Повторно её показать нельзя.',
  ];
}

/** Выполняет команду и возвращает код завершения: 0 успех, 1 ошибка выполнения, 2 неверный вызов. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    io.out(HELP);
    return 0;
  }
  // Секрет в аргументах: отказ до разбора, с подсказкой, как передать его правильно.
  if (rest.some((arg) => arg === '--client-secret' || arg.startsWith('--client-secret=') || arg === '--password')) {
    io.err('Секрет в аргументах не принимается: аргументы видны в списке процессов и в истории оболочки.');
    io.err('Задайте переменную HUB_OAUTH_CLIENT_SECRET или введите секрет, когда команда его спросит.');
    return 2;
  }
  const spec = command ? COMMANDS[command] : undefined;
  if (!command || !spec) {
    if (command) io.err(`Неизвестная команда: ${command.slice(0, 40)}`);
    io.err(HELP);
    return 2;
  }

  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: rest, options: spec.options, strict: true, allowPositionals: false }).values;
    const missing = spec.required.filter((name) => typeof values[name] !== 'string' || values[name] === '');
    if (missing.length > 0) throw new UsageError(`Не заданы ключи: ${missing.map((name) => `--${name}`).join(', ')}`);
  } catch (error) {
    io.err(error instanceof UsageError ? error.message : 'Неверные ключи команды.');
    io.err(HELP);
    return 2;
  }

  const text = (name: string) => values[name] as string;
  try {
    switch (command) {
      case 'staff:create': {
        const result = await inviteStaff(ACTOR, { email: text('email'), name: text('name'), role: text('role'), isLead: values.lead === true });
        io.out(`Приглашение для ${text('email')} создано.`);
        for (const line of linkLines(io.env, result)) io.out(line);
        return 0;
      }
      case 'staff:reset': {
        const result = await resetStaff(ACTOR, { email: text('email') });
        io.out(`Доступ ${text('email')} сброшен: пароль, второй фактор и все сессии удалены.`);
        for (const line of linkLines(io.env, result)) io.out(line);
        return 0;
      }
      case 'server:add': {
        const roleMap = parseJson('role-map', values['role-map'] as string | undefined);
        const endpoints = parseJson('endpoints', values.endpoints as string | undefined);
        const clientSecret = io.env.HUB_OAUTH_CLIENT_SECRET || (await io.readSecret('Секрет клиента OAuth: '));
        const { code } = await addServer(ACTOR, {
          code: text('code'),
          name: text('name'),
          baseUrl: text('base-url'),
          issuer: text('issuer'),
          clientId: text('client-id'),
          clientSecret,
          isDefault: values.default === true,
          roleMap,
          endpoints,
        });
        io.out(`Сервер ${code} сохранён.`);
        io.out(`Адрес возврата для регистрации портала в Smartup: ${io.env.HUB_URL ?? ''}/api/auth/sso/callback/${code}`);
        return 0;
      }
      case 'server:list': {
        const list = await listServers(ACTOR);
        if (list.length === 0) io.out('Серверов нет.');
        for (const server of list)
          io.out(
            [server.code, server.name, server.baseUrl, server.state === 'active' ? 'работает' : 'отключён', server.isDefault ? 'по умолчанию' : '']
              .filter(Boolean)
              .join('  '),
          );
        return 0;
      }
      case 'server:disable': {
        await disableServer(ACTOR, text('code'));
        io.out(`Сервер ${text('code')} отключён.`);
        return 0;
      }
      case 'server:widget': {
        // Без флага --embed-origins адреса встраивания не меняются; пустое значение флага очищает список.
        const origins = values['embed-origins'];
        const { secret } = await updateWidgetSettings(ACTOR, {
          code: text('code'),
          mode: text('key-mode'),
          ...(typeof values['jwks-url'] === 'string' && { jwksUrl: values['jwks-url'] }),
          ...(typeof origins === 'string' && { embedOrigins: origins.split(',').map((item) => item.trim()).filter(Boolean) }),
        });
        const server = await getServer(ACTOR, text('code'));
        io.out(`Виджет сервера ${text('code')} настроен.`);
        if (server) io.out(`Ключ встраивания: ${server.widget.embedKey}`);
        if (secret) io.out(`Общий секрет токена контекста (показывается один раз): ${secret}`);
        return 0;
      }
      case 'server:check': {
        const result = await checkServer(ACTOR, text('code'));
        if (result.ok) {
          io.out(`Сервер отвечает: ${text('code')}. Вход через него настроен верно.`);
          return 0;
        }
        io.out(`Сервер ${text('code')}: найдены проблемы.`);
        for (const issue of result.issues) io.out(`  ${ISSUE_TEXT[issue]}`);
        return 1;
      }
      case 'telegram:set-webhook': {
        const secret = io.env.TELEGRAM_WEBHOOK_SECRET;
        if (!io.env.TELEGRAM_BOT_TOKEN || !secret) {
          io.err('Бот выключен: задайте TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET.');
          return 1;
        }
        const { url } = await setTelegramWebhook({ hubUrl: io.env.HUB_URL ?? '', secret });
        io.out(`Вебхук бота поставлен: ${url}`);
        return 0;
      }
      case 'maintenance:cleanup': {
        const limits = await cleanupRateLimits();
        const updates = await cleanupTelegramUpdates(ACTOR);
        const { sessions, verifications, links } = await cleanupAuthRows(ACTOR);
        const sentMail = await cleanupOutbox(ACTOR);
        const letters = await cleanupInbound(ACTOR);
        io.out(
          `Удалено просроченных строк: счётчики частоты ${limits}, события Telegram ${updates}, сессии ${sessions}, одноразовые значения входа ${verifications}, ссылки и коды входа ${links}, отправленные письма очереди ${sentMail}, разобранные входящие письма ${letters}.`,
        );
        return 0;
      }
      case 'search:keys': {
        const url = io.env.TYPESENSE_URL;
        if (!url) throw new UsageError('Не задан TYPESENSE_URL: адрес службы typesense, например http://typesense:8108.');
        const masterKey = io.env.TYPESENSE_API_KEY || (await io.readSecret('Главный ключ Typesense: '));
        if (!masterKey) throw new UsageError('Главный ключ Typesense не введён.');
        const keys = await issueSearchKeys(ACTOR, { url, masterKey, rotate: values.rotate === true });
        io.out('Ключи созданы. Они показываются один раз: перенесите их в файлы окружения сейчас.');
        io.out(`Файл .env (портал): TYPESENSE_SEARCH_KEY=${keys.clientSearch}`);
        io.out(`Файл .env (портал): TYPESENSE_STAFF_SEARCH_KEY=${keys.staffSearch}`);
        io.out(`Файл .env.worker (фоновый процесс и hub): TYPESENSE_WRITE_KEY=${keys.write}`);
        if (keys.removed > 0) io.out(`Прежних ключей удалено: ${keys.removed}. Перезапустите web и worker с новыми ключами.`);
        return 0;
      }
      case 'search:reindex': {
        const collection = values.collection as string | undefined;
        if (collection !== undefined && !(SEARCH_COLLECTIONS as readonly string[]).includes(collection)) throw new UsageError(`Коллекция: ${SEARCH_COLLECTIONS.join(', ')}.`);
        const writer = getSearchWriter(io.env);
        if (!writer) throw new UsageError('Поиск на Typesense не включён: задайте SEARCH_PROVIDER=typesense, TYPESENSE_URL и TYPESENSE_WRITE_KEY.');
        registerSearch();
        // Коллекции и все настройки поиска (синонимы, словарь, курирование). При переиндексации одной коллекции смена
        // словаря перестраивает решения и идеи сразу; без ключа их строит цикл ниже.
        await prepareSearchIndex(ACTOR, writer, { reindexOnStems: collection !== undefined });
        for (const name of collection ? [collection as SearchCollection] : SEARCH_COLLECTIONS) {
          const result = await reindexCollection(ACTOR, writer, name);
          io.out(`${name}: построена ${result.name}, документов ${result.documents}.`);
        }
        return 0;
      }
      case 'search:status': {
        const writer = getSearchWriter(io.env);
        const queue = await searchQueueState(ACTOR);
        io.out(`Очередь записи: ждут ${queue.pending}, самая старая ${queue.lagSec} с, после пяти сбоев ${queue.dropped}.`);
        if (!writer) {
          io.out('Поиск идёт через PostgreSQL (SEARCH_PROVIDER не typesense).');
          return 0;
        }
        io.out(`Typesense: ${(await writer.health()) ? 'отвечает' : 'не отвечает'}.`);
        const collections = await writer.listCollections();
        for (const name of SEARCH_COLLECTIONS) {
          const target = await writer.aliasTarget(name);
          const info = collections.find((c) => c.name === target);
          io.out(`${name}: ${target ?? 'нет коллекции'}, документов ${info?.numDocuments ?? 0}.`);
        }
        const memory = await writer.memory();
        if (memory) io.out(`Память: занято ${Math.round(memory.usedBytes / 1048576)} МБ из ${Math.round(memory.totalBytes / 1048576)} МБ сервера.`);
        return 0;
      }
      case 'ops:backup-mark': {
        const kind = text('kind');
        if (!(BACKUP_KINDS as readonly string[]).includes(kind)) throw new UsageError(`Вид копии: ${BACKUP_KINDS.join(' или ')}.`);
        const bytes = values.bytes;
        if (bytes !== undefined && !(typeof bytes === 'string' && /^[1-9]\d{0,15}$/.test(bytes))) throw new UsageError('Размер копии --bytes: целое число байт больше нуля.');
        await markBackup(ACTOR, { kind: kind as BackupKind, ...(bytes !== undefined && { sizeBytes: Number(bytes) }) });
        io.out(`Отметка копии записана: ${kind}${bytes !== undefined ? `, ${bytes} байт` : ''}.`);
        return 0;
      }
      case 'ops:host-mark': {
        const share = (name: string) => {
          const value = text(name);
          if (!/^(100|[1-9]?\d)$/.test(value)) throw new UsageError(`Доля --${name}: целое число от 0 до 100.`);
          return Number(value);
        };
        // Имя сервера только из --host (независимая проверка M9, M2): hostname() контейнера меняется при пересоздании
        // и оставлял бы строки, по которым ops.watch слал host_mark_stale без конца.
        const host = text('host').toLowerCase();
        if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(host)) throw new UsageError('Имя сервера --host: латинские буквы, цифры, точка и дефис, до 63 знаков.');
        const [diskPct, memPct, cpuPct] = [share('disk'), share('mem'), share('cpu')];
        await markHost(ACTOR, { host, diskPct, memPct, cpuPct });
        io.out(`Отметка ресурсов записана: диск ${diskPct}%, память ${memPct}%, процессор ${cpuPct}%.`);
        return 0;
      }
      case 'sessions:revoke': {
        const user = values.user;
        const chosen = [typeof user === 'string', values.staff === true, values.all === true].filter(Boolean).length;
        if (chosen !== 1) throw new UsageError('Укажите ровно один охват: --user <адрес>, --staff или --all.');
        const scope = typeof user === 'string' ? { scope: 'user' as const, email: user } : values.staff === true ? { scope: 'staff' as const } : { scope: 'all' as const };
        const { revoked } = await revokeSessions(ACTOR, scope);
        io.out(`Завершено сессий: ${revoked} (${{ user: 'пользователь', staff: 'сотрудники', all: 'все' }[scope.scope]}).`);
        return 0;
      }
      case 'secrets:reseal': {
        const serverSecrets = await resealServerSecrets(ACTOR);
        const channelSecrets = await resealChannelSecrets(ACTOR);
        const webhookSecrets = await resealWebhookSecrets(ACTOR);
        io.out(`Перешифровано текущим ключом: серверы Smartup ${serverSecrets.resealed}, токены ботов ${channelSecrets.resealed}, секреты вебхуков ${webhookSecrets.resealed}.`);
        const failed = [
          ...serverSecrets.failed.map((code) => `сервер ${code}`),
          ...channelSecrets.failed.map((code) => CHANNEL_SECRET_NAMES[code] ?? code),
          ...webhookSecrets.failed.map((name) => `вебхук ${name}`),
        ];
        if (failed.length === 0) {
          io.out('Прежний ключ больше не нужен: уберите ENCRYPTION_KEY_PREVIOUS из окружения и перезапустите портал.');
          return 0;
        }
        io.err(`Не открываются ни текущим, ни прежним ключом: ${failed.join(', ')}.`);
        io.err('Проверьте ENCRYPTION_KEY_PREVIOUS или задайте эти секреты заново: server:add для сервера, экран настроек для бота, смена секрета на странице вебхука.');
        return 1;
      }
      case 'modules:import': {
        // Сначала администратор: от чужого имени файл даже не читается.
        const admin = await adminActorByEmail(ACTOR, text('admin'));
        let content: string;
        try {
          content = await readFile(text('file'), 'utf8');
        } catch {
          io.err(`Файл не прочитан: ${text('file')}`);
          return 1;
        }
        const result = await importModules(admin, content, 'cli');
        if (!result.ok) {
          io.err('Справочник не загружен, ошибки в файле:');
          for (const problem of result.problems) io.err(`  ${problem}`);
          return 1;
        }
        io.out(`Справочник модулей загружен: добавлено ${result.added}, обновлено ${result.updated}, скрыто ${result.passive}.`);
        return 0;
      }
      case 'seed:pilot': {
        const admin = await adminContextByEmail(ACTOR, text('admin'));
        let content: string;
        try {
          content = await readFile(text('file'), 'utf8');
        } catch {
          io.err(`Файл не прочитан: ${text('file')}`);
          return 1;
        }
        const dryRun = values['dry-run'] === true;
        let result: Awaited<ReturnType<typeof runSeedPilot>>;
        try {
          result = await runSeedPilot(admin, content, { dryRun });
        } catch (error) {
          // Файл проверен, отказал модуль при записи: записи до отказа остались (каждая своей транзакцией).
          if (!dryRun) io.err('Запись остановлена отказом модуля: записанное до него осталось, повторный запуск допишет остальное.');
          throw error;
        }
        if (!result.ok) {
          io.err('Начальные данные не загружены: файл не прошёл проверку, база не изменена. Ошибки:');
          for (const problem of result.problems) io.err(`  ${problem}`);
          return 1;
        }
        if (dryRun) io.out('Сухой прогон: ничего не записано. Так изменилась бы база:');
        for (const line of result.report.lines) io.out(line);
        for (const warning of result.report.warnings) io.out(`Внимание: ${warning}`);
        if (result.report.changes === 0) io.out('Изменений нет: база уже совпадает с файлом.');
        return 0;
      }
      case 'signatures:test':
        return await signaturesTest(typeof values.dir === 'string' && values.dir !== '' ? values.dir : CORPUS_DIR, io);
      case 'ideas:cycle': {
        const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text('month'));
        if (!month) throw new UsageError('Месяц задаётся как ГГГГ-ММ, например 2026-12.');
        // Время задания для этого месяца: 1-е число 09:00 по Ташкенту (04:00 UTC).
        const result = await runIdeaCycle(ACTOR, new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1, 4)));
        if (result.status === 'created')
          io.out(`Отбор ${result.cycle} создан: в пятёрке ${result.shortlist.length}${result.shortlist.length > 0 ? ` (${result.shortlist.map((n) => `I-${n}`).join(', ')})` : ''}, закрыто без выбора ${result.lapsed}.`);
        else if (result.status === 'exists') io.out(`Отбор ${result.cycle} уже есть, ничего не изменено.`);
        return 0;
      }
      case 'telegram:info': {
        const info = await telegramInfo();
        io.out(info.enabled ? `Бот включён: @${info.username}` : 'Бот выключен: TELEGRAM_BOT_TOKEN не задан.');
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return 2;
    }
    if (isHduError(error)) {
      io.err(ERROR_TEXT[error.code] ?? `Ошибка: ${error.code}`);
      return 1;
    }
    // Сбой Typesense: только код (адрес и ключ в вывод не идут).
    if (error instanceof SearchWriteError) {
      io.err(`Typesense не выполнил запрос: ${error.code}. Проверьте службу typesense и ключ записи.`);
      return 1;
    }
    // Подробности ошибки базы в вывод не идут: в них могут быть значения параметров.
    io.err('Команда не выполнена: ошибка сервера. Подробности в журнале.');
    console.error(error instanceof Error ? error.name : 'Error');
    return 1;
  }
  return 2;
}
