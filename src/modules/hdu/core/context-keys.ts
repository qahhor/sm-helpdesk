import 'server-only';
import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { getEnv } from '@/env';
import { isLocalPortal, safeFetchJson } from '../url-safety';
import type { ContextServer } from './servers';

// Ключи проверки подписи токена контекста виджета (план M6, задача 2; решения 2 и 3). Внешний сервис по правилу
// CLAUDE.md: интерфейс ContextKeySource, настоящая реализация здесь и заглушка в src/modules/hdu/testing.ts.
//
// Режим jwks: открытые ключи сервера Smartup по адресу из реестра. Скачивает их только сетевой слой исходящих запросов
// src/security/outbound.ts (через safeFetchJson): адрес проверяется при соединении (угроза T16). createRemoteJWKSet
// библиотеки jose ходил бы в сеть сам, мимо этого слоя, поэтому запрещён правилом линтера (eslint.config.mjs).
// Адрес ключей из самого токена (jku, x5u, jwk) не используется никогда.
//
// Кеш: открытые ключи серверов Smartup это настройки реестра, а не данные клиентов (решение 6 плана), их можно держать
// в памяти процесса. Срок 10 минут; токен с неизвестным kid загружает ключи заново, но не чаще раза в минуту на сервер.
//
// Режим secret: общий секрет из реестра, расшифрованный в readContextServer.

/** Чем проверять подпись токена контекста сервера: функция выбора открытого ключа или общий секрет. */
export type ContextKeySource = {
  keyFor(server: ContextServer): Promise<JWTVerifyGetKey | Uint8Array>;
};

const CACHE_MS = 10 * 60 * 1000;
const REFRESH_MS = 60 * 1000;
const FETCH_LIMITS = { timeoutMs: 5000, maxBytes: 64 * 1024 };

/** forcedAt: когда ключи последний раз загружались заново из-за неизвестного kid. */
type Entry = { url: string; jwks: JSONWebKeySet; fetchedAt: number; forcedAt: number };

const shared = globalThis as typeof globalThis & { __hubContextKeys?: Map<string, Entry>; __hubContextKeySource?: ContextKeySource | null };
const cache = (): Map<string, Entry> => (shared.__hubContextKeys ??= new Map());

/** Ключей нет или документ не похож на JWKS: подпись проверить нечем, токен отклоняется. */
export class ContextKeysUnavailableError extends Error {
  constructor() {
    super('Открытые ключи сервера Smartup не загружены');
    this.name = 'ContextKeysUnavailableError';
  }
}

function asJwks(doc: unknown): JSONWebKeySet {
  const keys = typeof doc === 'object' && doc !== null ? (doc as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 50) throw new ContextKeysUnavailableError();
  return { keys: keys.filter((key): key is JSONWebKeySet['keys'][number] => typeof key === 'object' && key !== null) };
}

async function download(url: string): Promise<JSONWebKeySet> {
  try {
    return asJwks(await safeFetchJson(new URL(url), { ...FETCH_LIMITS, allowLoopback: isLocalPortal(getEnv().HUB_URL) }));
  } catch {
    throw new ContextKeysUnavailableError();
  }
}

/** Ключи сервера из памяти или заново по адресу. force: загрузить заново, даже если срок не вышел. */
async function load(server: ContextServer, url: string, force: boolean): Promise<Entry> {
  const cached = cache().get(server.serverId);
  if (cached && cached.url === url && !force && Date.now() - cached.fetchedAt < CACHE_MS) return cached;
  const entry = { url, jwks: await download(url), fetchedAt: Date.now(), forcedAt: force ? Date.now() : (cached?.forcedAt ?? 0) };
  cache().set(server.serverId, entry);
  return entry;
}

/** Настоящий источник ключей: JWKS через сетевой слой исходящих запросов, общий секрет из реестра. */
export const registryKeySource: ContextKeySource = {
  async keyFor(server) {
    if (server.mode === 'secret') {
      if (!server.secret) throw new ContextKeysUnavailableError();
      return new TextEncoder().encode(server.secret);
    }
    const url = server.jwksUrl;
    if (!url) throw new ContextKeysUnavailableError();
    return async (header, token) => {
      const entry = await load(server, url, false);
      try {
        return await createLocalJWKSet(entry.jwks)(header, token);
      } catch (error) {
        // Неизвестный kid: сервер мог сменить ключ. Повторная загрузка не чаще раза в минуту, иначе поток токенов
        // с выдуманным kid заставлял бы портал без конца ходить на сервер Smartup.
        if (!(error instanceof errors.JWKSNoMatchingKey) || Date.now() - entry.forcedAt < REFRESH_MS) throw error;
        const fresh = await load(server, url, true);
        return createLocalJWKSet(fresh.jwks)(header, token);
      }
    };
  },
};

/** Источник ключей процесса. Тесты подменяют его заглушкой (setContextKeySourceForTests). */
export function contextKeySource(): ContextKeySource {
  return shared.__hubContextKeySource ?? registryKeySource;
}

/** Подмена источника ключей в тестах; null возвращает настоящий. */
export function setContextKeySourceForTests(source: ContextKeySource | null): void {
  shared.__hubContextKeySource = source;
}

/** Сброс памяти ключей между тестами. */
export function resetContextKeysForTests(): void {
  cache().clear();
}
