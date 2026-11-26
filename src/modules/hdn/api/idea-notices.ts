import 'server-only';

// Модуль hdn, слой api: уведомления по идеям для модуля hdi (план M7, задача 8). Узкий файл: его берут модуль идей
// (в своей транзакции) и фоновый процесс (сводка модерации), без страниц и Next.js.

export { type IdeaNotice, noticeSentRecentlyTx, notifyManyTx } from '../core/idea-notices';
export type { IdeaMailEvent } from '../mail/render';
