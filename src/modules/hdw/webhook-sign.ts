import { createHmac } from 'node:crypto';

// Модуль hdw: подпись исходящего вебхука (FR-AUTO-10; план M8, задача 5, решение 9). Чистый файл без базы.
// Заголовок X-Hub-Signature: t=<время в секундах>,v1=<HMAC-SHA256 от "<время>.<тело>" в шестнадцатеричном виде>.
// Ключ подписи: секрет адреса строкой, как его видел администратор. Время входит в подпись: приёмник отбрасывает
// старые запросы и так защищается от повтора перехваченного.

export const SIGNATURE_HEADER = 'X-Hub-Signature';
export const EVENT_HEADER = 'X-Hub-Event';
export const DELIVERY_HEADER = 'X-Hub-Delivery';

/** Значение заголовка подписи для тела rawBody в момент unixSeconds. */
export function signatureHeader(secret: string, unixSeconds: number, rawBody: string): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${rawBody}`).digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}
