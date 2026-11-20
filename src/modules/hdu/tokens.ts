import { createHash, randomBytes } from 'node:crypto';

// Одноразовые токены ссылок: приглашение, подтверждение адреса, вход из бота.
// В письмо или сообщение уходит сам токен, в базе лежит только его хеш (ТЗ 14.3).

/** Случайный токен (32 байта, 43 знака base64url) и его хеш для хранения. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Хеш SHA-256 в шестнадцатеричном виде: по нему токен ищется в базе. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
