import { createHmac, timingSafeEqual } from 'node:crypto';

// Ссылка оценки из письма (FR-TK-11, UX-C-07). В письме о закрытии обращения автор видит пять ссылок с оценками.
// Ссылка несёт номер обращения, автора и подпись: без входа в портал по ней можно только поставить оценку этому
// обращению. Срока у ссылки нет: оценка ставится один раз. Ключ подписи общий с адресами ответа, но подписывается
// другая строка (приставка "csat:"): подпись адреса ответа, которую видно в пересланном письме, ссылкой не станет.

const TOKEN = /^([1-9]\d{0,14})\.([0-9a-f]{32})\.([0-9a-f]{32})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sign = (number: number, userHex: string, secret: string) => createHmac('sha256', secret).update(`csat:${number}:${userHex}`).digest('hex').slice(0, 32);

export function csatToken(number: number, userId: string, secret: string): string {
  if (!UUID.test(userId) || !Number.isSafeInteger(number) || number <= 0) throw new Error('ссылка оценки: неверные данные');
  const userHex = userId.replaceAll('-', '');
  return `${number}.${userHex}.${sign(number, userHex, secret)}`;
}

/** Номер обращения и автор из ссылки. Порча формата или подпись не этим ключом: null. */
export function parseCsatToken(token: string, secrets: readonly string[]): { number: number; userId: string } | null {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, digits, userHex, signature] = match as unknown as [string, string, string, string];
  const number = Number(digits);
  const given = Buffer.from(signature, 'hex');
  const valid = secrets.some((secret) => timingSafeEqual(given, Buffer.from(sign(number, userHex, secret), 'hex')));
  if (!valid) return null;
  return { number, userId: `${userHex.slice(0, 8)}-${userHex.slice(8, 12)}-${userHex.slice(12, 16)}-${userHex.slice(16, 20)}-${userHex.slice(20)}` };
}
