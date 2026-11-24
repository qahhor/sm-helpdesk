import { HduError } from './error';
import { readLimited } from '@/modules/hdc/api';
import { BlockedAddressError, createGuardedFetch, isPrivateAddress, LOOPBACK_HOSTS, publicUrlOrNull, type Resolve, setDnsResolverForTests } from '@/security/outbound';

// Адреса серверов Smartup вводит администратор, и портал потом сам ходит по ним (документ discovery,
// ключи, обмен кода на токен). Чтобы этим нельзя было заставить портал обратиться во внутреннюю сеть
// (угроза T16, SSRF), адрес принимается, только если он внешний: схема https, узел не служебный,
// и ни один из адресов, в которые разрешается имя, не частный. Диапазоны адресов и сам запрос с проверкой
// при соединении живут в общем сетевом слое src/security/outbound.ts.

export { isPrivateAddress, type Resolve, setDnsResolverForTests };

const invalid = () => new HduError('invalid_input');

/**
 * Проверяет адрес сервера Smartup и возвращает его разобранным. Бросает HduError('invalid_input').
 *
 * allowLoopback: портал сам работает на localhost (разработка и тесты). Тогда допускаются
 * http и https на localhost и 127.0.0.1, например ложный сервер входа. Остальные правила не меняются.
 */
export async function assertPublicUrl(raw: string, opts: { allowLoopback: boolean; resolve?: Resolve }): Promise<URL> {
  // Сама проверка общая с адресами исходящих вебхуков: src/security/outbound.ts.
  const url = await publicUrlOrNull(raw, opts);
  if (!url) throw invalid();
  return url;
}

/** Работает ли сам портал на localhost: тогда локальные серверы входа допустимы. */
export function isLocalPortal(hubUrl: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(hubUrl).hostname);
}

// --- Загрузка документа с сервера Smartup (проверка связи, FR-ADM-01) ---

export type SafeFetchReason = 'unreachable' | 'timeout' | 'too_large' | 'not_json';

/** Документ не загружен. Адрес во внутреннюю сеть даёт не эту ошибку, а HduError('invalid_input'). */
export class SafeFetchError extends Error {
  constructor(readonly reason: SafeFetchReason) {
    super(`Документ не загружен: ${reason}`);
    this.name = 'SafeFetchError';
  }
}

/** Тело ответа не длиннее maxBytes байт. Длиннее: too_large, чтение прекращается. */
async function readLimitedOrThrow(response: Response, maxBytes: number): Promise<string> {
  const text = await readLimited(response, maxBytes);
  if (text === null) throw new SafeFetchError('too_large');
  return text;
}

/**
 * Загружает документ JSON с сервера Smartup. Адрес проверяется дважды (угроза T16): assertPublicUrl до запроса
 * и сетевой слой в момент соединения, тем же разрешением имени, которое получает сокет (находка S14: подмена
 * ответа DNS между проверкой и соединением). Перенаправления запрещены, тело читается не дальше maxBytes,
 * на всё отведено timeoutMs. Ошибки: HduError('invalid_input') для внутреннего адреса, иначе SafeFetchError.
 * opts.fetch подменяет сетевой слой в тестах.
 */
export async function safeFetchJson(
  url: URL,
  opts: { timeoutMs: number; maxBytes: number; allowLoopback: boolean; fetch?: typeof fetch; resolve?: Resolve },
): Promise<unknown> {
  await assertPublicUrl(url.toString(), { allowLoopback: opts.allowLoopback, resolve: opts.resolve });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SafeFetchError('timeout'));
    }, opts.timeoutMs);
  });
  const load = async () => {
    let response: Response;
    try {
      response = await (opts.fetch ?? createGuardedFetch({ allowLoopback: opts.allowLoopback, resolve: opts.resolve }))(url, {
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      if (error instanceof BlockedAddressError) throw invalid();
      throw new SafeFetchError('unreachable');
    }
    // Перенаправление тоже ошибка: новый адрес не проверен.
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SafeFetchError('unreachable');
    }
    const text = await readLimitedOrThrow(response, opts.maxBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SafeFetchError('not_json');
    }
  };
  try {
    return await Promise.race([load(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
