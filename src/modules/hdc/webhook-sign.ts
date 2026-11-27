import { createHmac } from 'node:crypto';

// Модуль hdc: подпись исходящего вебхука и события AI-сотрудника (FR-AUTO-10, FR-AGT-08; план M8, решение 9; план
// M8b, решение 26). Перенесена из hdw: одна функция для обоих модулей. Чистый файл без базы.
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
