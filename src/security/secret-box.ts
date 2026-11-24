import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '@/env';

// Шифрование секретов, которые портал хранит в базе (секрет клиента OAuth сервера Smartup).
// Алгоритм AES-256-GCM, ключ из переменной ENCRYPTION_KEY (ТЗ, разделы 11.2 и 13.5).
//
// Вид строки: v1.<iv>.<метка>.<данные>, части в base64url. Контекст (например, "hdu_servers:cloud")
// входит в проверку подлинности: строка, перенесённая в другое место хранения, не расшифруется.
//
// Замена ключа (аудит 23.11.2026, находка S6): новый ключ в ENCRYPTION_KEY, прежний в ENCRYPTION_KEY_PREVIOUS.
// Шифрует всегда текущий ключ; открывает текущий, а если не подошёл, прежний. Проверка подлинности AES-GCM не даёт
// открыть значение чужим ключом, поэтому перебор двух ключей безопасен. Команда hub secrets:reseal перешифровывает
// сохранённые значения текущим ключом, после неё прежний ключ из окружения убирают.

export type SecretBox = {
  seal(plain: string, context: string): string;
  open(sealed: string, context: string): string;
  /** Зашифровано ли значение прежним ключом. Не открывается ни одним ключом: ошибка, как у open. */
  needsReseal(sealed: string, context: string): boolean;
  /** То же значение, зашифрованное текущим ключом. */
  reseal(sealed: string, context: string): string;
};

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Ошибка без подробностей: ни секрет, ни зашифрованная строка в сообщение не попадают. */
function fail(): never {
  throw new Error('Секрет не удалось расшифровать: строка повреждена либо зашифрована другим ключом или для другого места');
}

export function createSecretBox(key: Buffer, previous: Buffer[] = []): SecretBox {
  for (const candidate of [key, ...previous]) if (candidate.length !== KEY_BYTES) throw new Error('Ключ шифрования должен быть длиной 32 байта');
  // Копии: изменение исходных буферов не должно менять ключи.
  const secret = Buffer.from(key);
  const older = previous.map((candidate) => Buffer.from(candidate));

  function openWith(candidate: Buffer, sealed: string, context: string): string | null {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) fail();
    const [, ivText, tagText, dataText] = parts as [string, string, string, string];
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) fail();
    try {
      const decipher = createDecipheriv('aes-256-gcm', candidate, iv);
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Значение и то, каким ключом оно открылось. */
  function openAny(sealed: string, context: string): { plain: string; current: boolean } {
    const now = openWith(secret, sealed, context);
    if (now !== null) return { plain: now, current: true };
    for (const candidate of older) {
      const plain = openWith(candidate, sealed, context);
      if (plain !== null) return { plain, current: false };
    }
    fail();
  }

  function seal(plain: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  return {
    seal,
    open: (sealed, context) => openAny(sealed, context).plain,
    needsReseal: (sealed, context) => !openAny(sealed, context).current,
    reseal: (sealed, context) => seal(openAny(sealed, context).plain, context),
  };
}

const shared = globalThis as typeof globalThis & { __hubSecretBox?: SecretBox };

/** Шифрование ключом из окружения. Создаётся при первом обращении: сборке приложения ключ не нужен. */
export function getSecretBox(): SecretBox {
  return (shared.__hubSecretBox ??= createSecretBox(
    Buffer.from(env.ENCRYPTION_KEY, 'base64'),
    env.ENCRYPTION_KEY_PREVIOUS ? [Buffer.from(env.ENCRYPTION_KEY_PREVIOUS, 'base64')] : [],
  ));
}
