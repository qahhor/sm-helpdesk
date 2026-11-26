// Установка и обновление схемы pg-boss (решение 0028) от роли hub_owner, затем права hub_app из 0012.
// Вызывается из migrate.mjs после SQL-миграций. Очереди создаются здесь же: у hub_app нет прав на объекты схемы.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';

export const PGBOSS_SCHEMA = 'pgboss';

/**
 * Очереди и их настройки повтора (раздел 11.10). Имена совпадают с JOB_NAMES в src/modules/hdc/jobs.ts (тест worker).
 * exclusive: для одного файла не больше одной задачи в очереди или в работе. short: не больше одной ждущей.
 * stately: не больше одной ждущей и одной выполняемой на ключ. Смена политики пересоздаёт очередь.
 */
export const QUEUES = {
  'attachment.scan': { policy: 'exclusive', retryLimit: 5, retryDelay: 30, retryBackoff: true, retryDelayMax: 600, expireInSeconds: 300 },
  'attachment.sweep': { policy: 'short', retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 86_400 },
  'maintenance.cleanup': { policy: 'short', retryLimit: 3, retryDelay: 600, expireInSeconds: 1800 },
  // Задача раз в минуту (план M3, задача 13): не больше одной ждущей, без повторов, следующая минута догонит.
  'tickets.minute': { policy: 'short', retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 86_400 },
  // Отправка очереди писем (веха M4, решение 1): раз в минуту и после действия, повторы ведёт сама очередь писем.
  'outbox.dispatch': { policy: 'short', retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 86_400 },
  // Разбор событий предметной области для правил (веха M8, решение 3): раз в минуту и после действия. Повторы
  // ведёт сама очередь событий (счётчик попыток в hdc_domain_events).
  'automation.process': { policy: 'short', retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 86_400 },
  // Отправка исходящих вебхуков (веха M8, решение 10): раз в минуту и после постановки доставки. Повторы ведёт
  // сама очередь доставок (hdw_webhook_deliveries).
  'webhooks.dispatch': { policy: 'short', retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 86_400 },
  // Опрос таск-менеджера Smartup (веха M8, решение 13): раз в 15 минут, только в режиме API. Без повторов:
  // задачу, которую не удалось прочитать, возьмёт следующий запуск.
  'devtasks.sync': { policy: 'short', retryLimit: 0, expireInSeconds: 600, deleteAfterSeconds: 86_400 },
  // Сигналы дежурным о состоянии портала (план W0, задача 4): раз в 5 минут, без повторов.
  'ops.watch': { policy: 'short', retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 86_400 },
  // Отметка "фоновый процесс жив" для /api/ready/worker (план подготовки M9, решение 5): раз в минуту, без повторов,
  // следующая минута догонит. Выполненные задачи хранятся сутки.
  'ops.heartbeat': { policy: 'short', retryLimit: 0, expireInSeconds: 60, deleteAfterSeconds: 86_400 },
  // Проверка изображения решения (план M5, задача 3): как вложение обращения, одна задача на файл.
  'kb.scan': { policy: 'exclusive', retryLimit: 5, retryDelay: 30, retryBackoff: true, retryDelayMax: 600, expireInSeconds: 300 },
  // Поисковый индекс после публикации (план M5, задача 4 ставит, задача 9 пишет строки и вектор). stately: на решение
  // одна ждущая и одна выполняемая задача, иначе публикация во время выполнения терялась бы (повторная проверка M5,
  // 0057). Сервис векторов недоступен: повтор с растущей паузой, пропущенное найдёт ночная сверка kb.reconcile.
  'kb.index': { policy: 'stately', retryLimit: 5, retryDelay: 60, retryBackoff: true, retryDelayMax: 1800, expireInSeconds: 300 },
  // Ночная сверка индекса (план M5, задача 9): статьи без строки индекса или без вектора, исходы подсказки старше
  // 13 месяцев. Без повторов: следующая ночь догонит.
  'kb.reconcile': { policy: 'short', retryLimit: 0, expireInSeconds: 1800, deleteAfterSeconds: 86_400 },
  // Задачи модели (план M5, задачи 6 и 7, решение 3): машинный перевод языка решения и черновик из обращения. Повтор
  // при сбое модели с растущей паузой; повторную постановку при уже поставленной задаче отсекает состояние ai_status.
  'kb.translate': { policy: 'standard', retryLimit: 3, retryDelay: 30, retryBackoff: true, retryDelayMax: 600, expireInSeconds: 300 },
  'kb.draft': { policy: 'standard', retryLimit: 3, retryDelay: 30, retryBackoff: true, retryDelayMax: 600, expireInSeconds: 300 },
  // Идеи (веха M7): проверка изображения как у решений; индекс похожих и машинный перевод после публикации и правки.
  // stately: на идею одна ждущая и одна выполняемая задача, правка во время выполнения не теряется.
  'ideas.scan': { policy: 'exclusive', retryLimit: 5, retryDelay: 30, retryBackoff: true, retryDelayMax: 600, expireInSeconds: 300 },
  'ideas.index': { policy: 'stately', retryLimit: 5, retryDelay: 60, retryBackoff: true, retryDelayMax: 1800, expireInSeconds: 300 },
  'ideas.translate': { policy: 'stately', retryLimit: 3, retryDelay: 30, retryBackoff: true, retryDelayMax: 600, expireInSeconds: 300 },
  // Сводка модерации идей роли product раз в день (план M7, задача 8): повтор в тот же день ничего не шлёт.
  'ideas.moderation_digest': { policy: 'short', retryLimit: 2, retryDelay: 300, expireInSeconds: 600 },
  // Отбор месяца (план M7, задача 9): 1-го числа в 09:00 по Ташкенту. Повтор безвреден: месяц уникален, снимок один.
  'ideas.cycle': { policy: 'short', retryLimit: 3, retryDelay: 300, expireInSeconds: 600 },
  // Индекс поиска Typesense (план W6, решения 11 и 12): разбор очереди hdc_search_outbox раз в минуту, внутри запуска
  // до 50 секунд с опросом каждые 2 секунды. singleton: не больше одного выполняемого запуска, порядок записи один.
  // Повторы ведёт сама очередь (attempts в hdc_search_outbox). Ночная сверка без повторов: следующая ночь догонит.
  'search.sync': { policy: 'singleton', retryLimit: 0, expireInSeconds: 120, deleteAfterSeconds: 86_400 },
  'search.reconcile': { policy: 'short', retryLimit: 0, expireInSeconds: 3600, deleteAfterSeconds: 86_400 },
  // Разбор входящего письма (веха M4, решение 10): одна задача на письмо, повторы при сбое сервиса почты.
  'email.inbound': { policy: 'exclusive', retryLimit: 5, retryDelay: 60, retryBackoff: true, retryDelayMax: 1800, expireInSeconds: 300 },
};

const GRANTS_FILE = resolve(import.meta.dirname, '../../drizzle/0012_pgboss_grants.sql');
const BAM_WAIT_MS = 10 * 60_000;

/**
 * Ставит или обновляет pg-boss, создаёт очереди и обновляет их настройки, ждёт фоновые перестройки индексов
 * самой библиотеки (их выполняет только экземпляр с правом миграций) и выдаёт права hub_app.
 * @param {string} ownerUrl адрес подключения роли hub_owner
 */
export async function installPgBoss(ownerUrl) {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: PGBOSS_SCHEMA,
    application_name: 'hub-migrate',
    migrate: true,
    supervise: false,
    schedule: false,
    registerInstance: false,
    max: 2,
  });
  let failure;
  boss.on('error', (error) => (failure ??= error));
  await boss.start();
  try {
    for (const [name, options] of Object.entries(QUEUES)) {
      const existing = await boss.getQueue(name);
      if (existing && existing.policy !== options.policy) {
        // Политику очереди библиотека не меняет: очередь пересоздаётся. Ждущие задачи пропадают; у очередей, где так
        // бывает (kb.index), их догоняет ночная сверка (0057).
        await boss.deleteQueue(name);
        await boss.createQueue(name, options);
      } else if (existing) {
        const { policy: _policy, ...updatable } = options;
        void _policy;
        await boss.updateQueue(name, updatable);
      } else await boss.createQueue(name, options);
    }
    const until = Date.now() + BAM_WAIT_MS;
    for (;;) {
      const status = await boss.getBamStatus();
      if (status.some((s) => s.status === 'failed' && s.count > 0)) throw new Error('pg-boss: фоновая перестройка индексов не удалась');
      if (!status.some((s) => (s.status === 'pending' || s.status === 'in_progress') && s.count > 0)) break;
      if (Date.now() > until) throw new Error('pg-boss: фоновая перестройка индексов не закончилась за 10 минут');
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
  if (failure) throw failure;
  // Права hub_app на объекты, созданные или пересозданные библиотекой.
  const client = new (await import('pg')).default.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(await readFile(GRANTS_FILE, 'utf8'));
  } finally {
    await client.end();
  }
}
