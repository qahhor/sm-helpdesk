import 'server-only';

// Модуль hdn, слой api: очередь исходящих (FR-NT-09, решения 1-3 вехи M4). Узкий файл: его берут модули
// (постановка в своей транзакции) и фоновый процесс (отправка), без страниц и Next.js.

export {
  dispatchOutbox,
  enqueueTx,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_RETRY_MINUTES,
  outboxState,
  type OncallSender,
  type OutboxItem,
  recordDelivery,
  undeliveredMessages,
  wakeOutbox,
} from '../core/outbox';
export { TELEGRAM_TEMPLATES } from '../core/telegram-text';
