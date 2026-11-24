// Установка и обновление схемы pg-boss (решение 0028) от роли hub_owner, затем права hub_app из 0012.
// Вызывается из migrate.mjs после SQL-миграций. Очереди создаются здесь же: у hub_app нет прав на объекты схемы.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';

export const PGBOSS_SCHEMA = 'pgboss';

/**
 * Очереди и их настройки повтора (раздел 11.10). Имена совпадают с JOB_NAMES в src/modules/hdc/jobs.ts (тест worker).
 * exclusive: для одного файла не больше одной задачи в очереди или в работе. short: не больше одной ждущей.
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
  // Сигналы дежурным о состоянии портала (план W0, задача 4): раз в 5 минут, без повторов.
  'ops.watch': { policy: 'short', retryLimit: 0, expireInSeconds: 300, deleteAfterSeconds: 86_400 },
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
      if (await boss.getQueue(name)) {
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
