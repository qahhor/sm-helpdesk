// Запуск собранного приложения для проверки Lighthouse (pnpm lighthouse).
// Задаёт порт и окружение, которого достаточно страницам без базы данных.
process.env.PORT = '3102';
process.env.HUB_URL = 'http://localhost:3102';
process.env.HUB_DOMAIN = 'localhost';
process.env.DATABASE_URL_APP ??= 'postgres://hub_app:lighthouse@127.0.0.1:5432/hub';
process.env.DATABASE_URL_AUTH ??= 'postgres://hub_auth:lighthouse@127.0.0.1:5432/hub';
await import('./start-standalone.mjs');
