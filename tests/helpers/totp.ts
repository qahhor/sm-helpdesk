import { createHmac } from 'node:crypto';

// Код TOTP по RFC 6238 (HMAC-SHA1, шаг 30 секунд, 6 цифр): то, что показывает приложение с кодами.
// Нужен тестам входа сотрудника. В коде портала коды считает библиотека входа.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  let bits = '';
  for (const char of text.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Ключ второго фактора записан не в base32');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** @param secret ключ в base32, как он показан на экране подключения второго фактора */
export function totp(secret: string, at: Date = new Date()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

const used = new Map<string, number>();

/**
 * Код, ещё не принятый порталом в этом прогоне: портал отклоняет повтор кода (проверка main, S11).
 * Библиотека принимает коды соседних шагов, поэтому по очереди даются коды шагов 0, -1 и +1.
 */
export function freshTotp(secret: string): string {
  const n = used.get(secret) ?? 0;
  const offset = [0, -1, 1][n];
  if (offset === undefined) throw new Error('Больше трёх входов с одним ключом за 30 секунд тест сделать не может');
  used.set(secret, n + 1);
  return totp(secret, new Date(Date.now() + offset * 30_000));
}
