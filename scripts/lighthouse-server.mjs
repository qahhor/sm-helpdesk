// Запуск собранного приложения для проверки Lighthouse (pnpm lighthouse).
// Задаёт порт и адрес. Адреса базы и секреты берутся из .env, если он есть (страница входа читает базу),
// иначе подставляются значения, которых достаточно страницам без базы данных.
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.PORT = '3102';
process.env.HUB_URL = 'http://localhost:3102';
process.env.HUB_DOMAIN = 'localhost';
process.env.MAIL_TRANSPORT = 'none';
process.env.DATABASE_URL_APP ??= 'postgres://hub_app:lighthouse@127.0.0.1:5432/hub';
process.env.DATABASE_URL_AUTH ??= 'postgres://hub_auth:lighthouse@127.0.0.1:5432/hub';
process.env.BETTER_AUTH_SECRET ??= 'lighthouse-only-secret-of-32-characters!';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString('base64');
await import('./start-standalone.mjs');
