import { createHmac, timingSafeEqual } from 'node:crypto';

// Модуль hdw: подпись входящего вебхука таск-менеджера Smartup (FR-DEV-04; план M8, задача 8). Чистый файл без базы.
//
// ВНИМАНИЕ: описание настоящего API не получено. Заголовки и формула подписи здесь это предполагаемый договор
// (docs/integrations/dev-tracker.md): X-Tracker-Timestamp с временем в секундах и X-Tracker-Signature вида
// sha256=<HMAC-SHA256 от "<время>.<тело как пришло>" общим секретом, шестнадцатеричная запись>. Время входит в
// подпись: перехваченный запрос нельзя повторить позже с новым временем.

export const TRACKER_TIMESTAMP_HEADER = 'x-tracker-timestamp';
export const TRACKER_SIGNATURE_HEADER = 'x-tracker-signature';
/** Запрос старше или новее этого не принимается, секунд. */
export const TRACKER_SIGNATURE_WINDOW_SEC = 300;

/** Значение заголовка подписи для тела rawBody в момент unixSeconds. */
export function trackerSignature(secret: string, unixSeconds: number, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${unixSeconds}.${rawBody}`).digest('hex')}`;
}

export type TrackerSignatureCheck = 'ok' | 'missing' | 'malformed' | 'bad_signature' | 'stale';

/**
 * Проверка подписи вебхука. Сравнение подписей за постоянное время. Сначала подпись, потом окно времени: о том,
 * что время устарело, узнаёт только тот, кто знает секрет.
 */
export function verifyTrackerSignature(input: { secret: string; timestamp: string | null; signature: string | null; rawBody: string; now: Date }): TrackerSignatureCheck {
  if (!input.timestamp || !input.signature) return 'missing';
  if (!/^\d{1,12}$/.test(input.timestamp) || !/^sha256=[0-9a-f]{64}$/.test(input.signature)) return 'malformed';
  const seconds = Number(input.timestamp);
  const expected = Buffer.from(trackerSignature(input.secret, seconds, input.rawBody), 'utf8');
  const given = Buffer.from(input.signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'bad_signature';
  if (Math.abs(Math.floor(input.now.getTime() / 1000) - seconds) > TRACKER_SIGNATURE_WINDOW_SEC) return 'stale';
  return 'ok';
}
