import { createHmac, timingSafeEqual } from 'node:crypto';

// Подпись вебхука по схеме Svix, которой Resend подписывает запросы (решение 10 вехи M4).
// Подписывается строка "svix-id.svix-timestamp.тело" ключом HMAC-SHA256: ключ это base64 после префикса whsec_.
// В заголовке svix-signature одна или несколько подписей "v1,<base64>" через пробел (смена секрета без простоя).

/** Насколько метка времени может отличаться от часов сервера, секунд: защита от повтора старого запроса. */
export const SVIX_TOLERANCE_SEC = 5 * 60;

const PREFIX = 'whsec_';

export function verifySvix(secret: string, id: string, timestamp: string, signatures: string, body: string, now: Date): boolean {
  if (!secret.startsWith(PREFIX) || id === '' || !/^\d{1,12}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (Math.abs(now.getTime() / 1000 - seconds) > SVIX_TOLERANCE_SEC) return false;
  const key = Buffer.from(secret.slice(PREFIX.length), 'base64');
  if (key.length === 0) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  for (const part of signatures.split(' ')) {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
