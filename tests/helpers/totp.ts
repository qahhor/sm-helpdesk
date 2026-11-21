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

/** Шаги кода (номер 30-секундного окна), уже выданные по каждому ключу в этом прогоне. */
const usedSteps = new Map<string, Set<number>>();

/**
 * Код, ещё не принятый порталом в этом прогоне: портал отклоняет повтор кода (проверка main, S11).
 * Библиотека принимает коды соседних шагов. Шаги считаются от начала эпохи, а не от момента вызова:
 * иначе при переходе через границу 30 секунд "предыдущий" шаг второго входа совпадал с "текущим" первого.
 * Порядок: текущий, следующий (он дольше остаётся годным), предыдущий.
 */
export function freshTotp(secret: string): string {
  const now = Math.floor(Date.now() / 30_000);
  const used = usedSteps.get(secret) ?? new Set<number>();
  usedSteps.set(secret, used);
  for (const step of [now, now + 1, now - 1]) {
    if (used.has(step)) continue;
    used.add(step);
    return totp(secret, new Date(step * 30_000));
  }
  throw new Error('Больше трёх входов с одним ключом за 30 секунд тест сделать не может');
}
