import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { SystemActor } from '@/db/with-actor';
import { addServer, checkServer, disableServer, listServers, type ServerIssue } from '@/modules/hdu/api/servers';
import { adminActorByEmail, inviteStaff, resetStaff } from '@/modules/hdu/api/staff-admin';
import { isHduError } from '@/modules/hdu/api/errors';
import { setTelegramWebhook, telegramInfo } from '@/modules/hdn/api/telegram-admin';
import { cleanupInbound, cleanupOutbox, cleanupTelegramUpdates } from '@/modules/hdn/api/maintenance';
import { cleanupAuthRows } from '@/modules/hdu/api/maintenance';
import { cleanupRateLimits } from '@/modules/hdc/api';
import { importModules } from '@/modules/hdr/api/import';

// Команда hub для консоли сервера (FR-ID-12, решение 0015): первый администратор, сброс доступа
// сотрудника, реестр серверов Smartup. Работает от актора system, каждое изменение пишется в журнал аудита.
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

  maintenance:cleanup
      Удалить просроченные служебные строки: счётчики частоты, номера событий Telegram, сессии
      и одноразовые значения входа. Запускать раз в сутки, пока нет фоновых задач (решение 0023).

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
  'telegram:set-webhook': { options: {}, required: [] },
  'telegram:info': { options: {}, required: [] },
  'maintenance:cleanup': { options: {}, required: [] },
  'modules:import': { options: { file: { type: 'string' }, admin: { type: 'string' } }, required: ['file', 'admin'] },
};

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
    // Подробности ошибки базы в вывод не идут: в них могут быть значения параметров.
    io.err('Команда не выполнена: ошибка сервера. Подробности в журнале.');
    console.error(error instanceof Error ? error.name : 'Error');
    return 1;
  }
  return 2;
}
