import { createHmac, timingSafeEqual } from 'node:crypto';

// Адрес для ответа на письмо (раздел 11.8 ТЗ, FR-NT-06, решение 9 вехи M4):
// reply+<номер обращения>.<пользователь в base32, 26 знаков>.<20 знаков hex HMAC>@<REPLY_DOMAIN>.
// Только строчные буквы и цифры: почтовые серверы могут менять регистр. Местная часть не длиннее 64 знаков
// при номере до 7 цифр. Подпись сверяется за постоянное время.

export type ReplyConfig = { domain: string; secret: string };

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const SIG_LENGTH = 20;
const ADDRESS = /^reply\+(\d{1,12})\.([a-z2-7]{26})\.([0-9a-f]{20})@([a-z0-9.-]{1,253})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const short = (userId: string) => toBase32(Buffer.from(userId.replaceAll('-', ''), 'hex'));
const sign = (number: number, userShort: string, secret: string) =>
  createHmac('sha256', secret).update(`${number}:${userShort}`).digest('hex').slice(0, SIG_LENGTH);

export function replyAddress(number: number, userId: string, cfg: ReplyConfig): string {
  if (!UUID.test(userId) || !Number.isSafeInteger(number) || number <= 0) throw new Error('адрес ответа: неверные данные');
  const userShort = short(userId);
  return `reply+${number}.${userShort}.${sign(number, userShort, cfg.secret)}@${cfg.domain.toLowerCase()}`;
}

/** Номер и пользователь из подписанного адреса. Чужой домен, неверная подпись, порча формата: null. */
export function parseReplyAddress(address: string, cfg: ReplyConfig): { number: number; userId: string } | null {
  const match = ADDRESS.exec(address.trim().toLowerCase());
  if (!match) return null;
  const [, numberText, userShort, sig, domain] = match as unknown as [string, string, string, string, string];
  if (domain !== cfg.domain.toLowerCase()) return null;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const expected = Buffer.from(sign(number, userShort, cfg.secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const bytes = fromBase32(userShort);
  if (!bytes || bytes.length !== 16) return null;
  const hex = bytes.toString('hex');
  return { number, userId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
}

let override: ReplyConfig | null | undefined;

/** Тесты задают домен и секрет адресов ответа (undefined возвращает настройки окружения). */
export function setReplyConfigForTests(cfg: ReplyConfig | null | undefined): void {
  override = cfg;
}

/** Домен и секрет адресов ответа из окружения (REPLY_DOMAIN, REPLY_HMAC_SECRET). Не заданы: приём выключен. */
export function replyConfigOf(env: { REPLY_DOMAIN?: string; REPLY_HMAC_SECRET?: string }): ReplyConfig | null {
  if (override !== undefined) return override;
  return env.REPLY_DOMAIN && env.REPLY_HMAC_SECRET ? { domain: env.REPLY_DOMAIN, secret: env.REPLY_HMAC_SECRET } : null;
}
