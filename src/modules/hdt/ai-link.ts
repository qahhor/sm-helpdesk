import { createHmac, timingSafeEqual } from 'node:crypto';

// Ссылка из письма и кнопка Telegram под ответом Теза (план M5b, задача 6; FR-NT-11, FR-EM-12; пункт 7 проверки на
// AI-инъекции; образец: оценка по ссылке, решение 0040). Подпись называет получателя, сообщение помощника и выбор
// ("Помогло" или "Нужен сотрудник"), у ссылки письма ещё срок 7 суток. Таблицы нет: второе нажатие не срабатывает,
// потому что обращение уже не ждёт реакции на это сообщение. Ключ общий с адресами ответа, подписываемая строка
// своя (приставки "tez:" и "tzc:"): подпись адреса ответа или ссылки оценки ссылкой Теза не станет.

export const AI_LINK_TTL_MS = 7 * 86_400_000;
export type AiLinkChoice = 'helped' | 'need_staff';

const CODES: Record<AiLinkChoice, string> = { helped: 'h', need_staff: 's' };
const CHOICES: Record<string, AiLinkChoice> = { h: 'helped', s: 'need_staff' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^([0-9a-f]{32})\.([0-9a-f]{32})\.([0-9a-z]{1,10})\.([hs])\.([0-9a-f]{32})$/;
const CALLBACK = /^tz:([hs]):([0-9a-f]{32}):([0-9a-f]{12})$/;

const hex = (uuid: string) => {
  if (!UUID.test(uuid)) throw new Error('ссылка Теза: неверный идентификатор');
  return uuid.replaceAll('-', '');
};
const uuidOf = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const mac = (text: string, secret: string, size: number) => createHmac('sha256', secret).update(text).digest('hex').slice(0, size);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export function aiLinkToken(input: { messageId: string; userId: string; choice: AiLinkChoice; now: Date }, secret: string): string {
  const m = hex(input.messageId);
  const u = hex(input.userId);
  const exp = Math.floor((input.now.getTime() + AI_LINK_TTL_MS) / 1000).toString(36);
  const c = CODES[input.choice];
  return `${m}.${u}.${exp}.${c}.${mac(`tez:${m}:${u}:${exp}:${c}`, secret, 32)}`;
}

export type AiLinkParsed = { ok: true; messageId: string; userId: string; choice: AiLinkChoice } | { ok: false; code: 'link_invalid' | 'expired' };

export function parseAiLinkToken(token: string, secrets: readonly string[], now: Date): AiLinkParsed {
  const match = TOKEN.exec(token);
  if (!match) return { ok: false, code: 'link_invalid' };
  const [, m, u, exp, c, signature] = match as unknown as [string, string, string, string, string, string];
  if (!secrets.some((secret) => same(signature, mac(`tez:${m}:${u}:${exp}:${c}`, secret, 32)))) return { ok: false, code: 'link_invalid' };
  if (parseInt(exp, 36) * 1000 < now.getTime()) return { ok: false, code: 'expired' };
  return { ok: true, messageId: uuidOf(m), userId: uuidOf(u), choice: CHOICES[c]! };
}

/** Данные кнопки Telegram: до 64 байт; получатель не в данных, а в подписи: его называет привязка бота. */
export function aiCallbackData(input: { messageId: string; userId: string; choice: AiLinkChoice }, secret: string): string {
  const m = hex(input.messageId);
  const c = CODES[input.choice];
  return `tz:${c}:${m}:${mac(`tzc:${m}:${hex(input.userId)}:${c}`, secret, 12)}`;
}

export function parseAiCallbackData(data: string, userId: string, secrets: readonly string[]): { messageId: string; choice: AiLinkChoice } | null {
  const match = CALLBACK.exec(data);
  if (!match || !UUID.test(userId)) return null;
  const [, c, m, signature] = match as unknown as [string, string, string, string];
  const u = hex(userId);
  if (!secrets.some((secret) => same(signature, mac(`tzc:${m}:${u}:${c}`, secret, 12)))) return null;
  return { messageId: uuidOf(m), choice: CHOICES[c]! };
}
