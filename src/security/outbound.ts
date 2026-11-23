import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

// Общий сетевой слой исходящих запросов по адресам, которые портал получает извне: адрес сервера Smartup вводит
// администратор, ссылку на вложение присылает почтовый сервис. Чтобы этим нельзя было заставить портал обратиться
// во внутреннюю сеть (угроза T16, SSRF), имя узла разрешается и проверяется в момент соединения: тем же вызовом,
// который отдаёт адрес сокету. Проверки "до запроса" для этого мало: между проверкой и соединением ответ DNS можно
// подменить (аудит 23.11.2026, находка S14). Переадресации слой не выполняет: новый адрес проверяет вызывающий.

export type Resolve = (host: string) => Promise<string[]>;

// Частные, локальные и служебные диапазоны. Документационные (192.0.2.0/24, 203.0.113.0/24, 2001:db8::/32)
// не закрыты: в интернете они не встречаются, а тестам нужны.
// Списки для IPv4 и IPv6 раздельные: BlockList проверяет адрес IPv4 и по правилам IPv6 в виде ::ffff:a.b.c.d,
// и правило ::ffff:0:0/96 закрыло бы все адреса IPv4.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED_V4.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  // Весь диапазон ::/96: пустой адрес, петля ::1 и устаревшая запись IPv4 внутри IPv6 (::127.0.0.1).
  ['::', 96],
  // Любой IPv4 в записи IPv6 закрыт целиком: так не проверять его отдельно.
  ['::ffff:0:0', 96],
  // Тот же IPv4 в записи для трансляторов (::ffff:0:a.b.c.d) и устаревшие локальные адреса площадки.
  ['::ffff:0:0:0', 96],
  ['fec0::', 10],
  ['64:ff9b::', 96],
  // Тоже несут адрес IPv4 внутри: локальный NAT64, 6to4 и Teredo (итоговая проверка M1).
  ['64:ff9b:1::', 48],
  ['2002::', 16],
  ['2001::', 32],
  ['100::', 64],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4 ? BLOCKED_V4.check(address, 'ipv4') : BLOCKED_V6.check(address, 'ipv6');
}

const systemResolve: Resolve = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const shared = globalThis as typeof globalThis & { __hubDnsResolve?: Resolve | null; __hubOutboundFetch?: typeof fetch | null };

/**
 * Подмена разрешения имён в тестах: имена вида *.example в настоящем DNS не разрешаются.
 * null возвращает системное разрешение.
 */
export function setDnsResolverForTests(resolve: Resolve | null): void {
  shared.__hubDnsResolve = resolve;
}

/**
 * Подмена самого запроса в тестах: ответ сервера Smartup без сети. Проверки адреса при этом не выполняются,
 * поэтому подмену ставят только тесты. null возвращает настоящий запрос.
 */
export function setOutboundFetchForTests(impl: typeof fetch | null): void {
  shared.__hubOutboundFetch = impl;
}

/** Разрешение имён: заданное вызывающим, подменённое тестами или системное. */
export function resolverFor(resolve?: Resolve): Resolve {
  return resolve ?? shared.__hubDnsResolve ?? systemResolve;
}

/** Имя узла из адреса: без скобок IPv6, без точки в конце, строчными. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/** Запрос отклонён до соединения: адрес внутренний, имя не разрешается или схема не https. Подробностей в сообщении нет. */
export class BlockedAddressError extends Error {
  constructor() {
    super('Исходящий запрос отклонён: адрес не внешний');
    this.name = 'BlockedAddressError';
  }
}

/**
 * Разрешение имени для сокета с проверкой: если имя не разрешается или хотя бы один адрес внутренний, соединения нет.
 * Сокет получает только адреса из проверенного списка. Node просит ответ списком (выбор семейства адресов)
 * или одним адресом: отдаются оба вида.
 */
export function guardedLookup(resolve: Resolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some(isPrivateAddress)) return callback(new BlockedAddressError(), '', 0);
        const list = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options.all) return callback(null, list);
        const first = list[0] as { address: string; family: number };
        return callback(null, first.address, first.family);
      },
      () => callback(new BlockedAddressError(), '', 0),
    );
  };
}

export type GuardedFetchConfig = {
  /** Портал сам работает на localhost (разработка и тесты): допускаются http и https на localhost и 127.0.0.1. */
  allowLoopback: boolean;
  resolve?: Resolve;
};

/**
 * Запрос в духе fetch поверх node:https. Отличия от обычного fetch:
 *   - только https (в локальном режиме ещё http и https на localhost и 127.0.0.1);
 *   - имя узла разрешается при соединении, и если хотя бы один адрес внутренний, соединения нет (BlockedAddressError);
 *   - переадресации не выполняются: ответ 3xx возвращается как есть;
 *   - соединения не переиспользуются: каждое проверяется заново.
 * Из параметров запроса учитываются method (GET или HEAD), headers и signal. Запрос с телом, с иным методом
 * или готовым объектом Request отклоняется: слой только читает.
 */
export function createGuardedFetch(cfg: GuardedFetchConfig): typeof fetch {
  return (input, init = {}) => {
    if (shared.__hubOutboundFetch) return shared.__hubOutboundFetch(input, init);
    return new Promise<Response>((done, reject) => {
      let url: URL;
      try {
        url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      } catch {
        return reject(new BlockedAddressError());
      }
      const host = hostOf(url);
      const loopback = cfg.allowLoopback && LOOPBACK_HOSTS.has(host);
      if (url.username || url.password) return reject(new BlockedAddressError());
      if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return reject(new BlockedAddressError());
      // Адрес числом: разрешения имени не будет, проверка здесь.
      if (!loopback && isIP(host) !== 0 && isPrivateAddress(host)) return reject(new BlockedAddressError());

      // Слой только читает. Запрос с телом или иным методом ушёл бы без тела и как GET: лучше отказ, чем тихая подмена.
      const method = (init.method ?? 'GET').toUpperCase();
      if (input instanceof Request || init.body != null || (method !== 'GET' && method !== 'HEAD'))
        return reject(new TypeError('Сетевой слой исходящих запросов только читает: метод GET или HEAD, без тела'));

      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        // Локальный узел разрешает система: подмена имён в тестах его не касается.
        { method, headers, agent: false, signal: init.signal ?? undefined, ...(loopback ? {} : { lookup: guardedLookup(resolverFor(cfg.resolve)) }) },
        (response) => {
          const status = response.statusCode ?? 0;
          const out = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) out.append(name, item);
            else if (value !== undefined) out.set(name, value);
          }
          const empty = status === 204 || status === 205 || status === 304;
          if (empty) response.resume();
          try {
            done(new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status, headers: out }));
          } catch (error) {
            response.destroy();
            reject(error);
          }
        },
      );
      request.on('error', (error) => reject(error));
      request.end();
    });
  };
}
