import setup from '../integration/setup/global-setup';

// Замер (план M9-prep, задача 4): база с настройками памяти и статистики запросов из compose.prod.yaml (сервер 8 ГБ),
// иначе замер сравнивает портал с образом PostgreSQL по умолчанию. Переменная PG_SETTINGS задаёт свои значения.
export default function perfSetup() {
  process.env.PG_SETTINGS ??= 'shared_buffers=1GB effective_cache_size=3GB work_mem=16MB maintenance_work_mem=256MB max_connections=100';
  return setup();
}
