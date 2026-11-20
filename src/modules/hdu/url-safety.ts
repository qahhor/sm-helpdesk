import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HduError } from './error';

// Адреса серверов Smartup вводит администратор, и портал потом сам ходит по ним (документ discovery,
// ключи, обмен кода на токен). Чтобы этим нельзя было заставить портал обратиться во внутреннюю сеть
// (угроза T16, SSRF), адрес принимается, только если он внешний: схема https, узел не служебный,
// и ни один из адресов, в которые разрешается имя, не частный.

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
  ['::', 128],
  ['::1', 128],
  // Любой IPv4 в записи IPv6 закрыт целиком: так не проверять его отдельно.
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED_V6.addSubnet(net, prefix, 'ipv6');

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4 ? BLOCKED_V4.check(address, 'ipv4') : BLOCKED_V6.check(address, 'ipv6');
}

const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const shared = globalThis as typeof globalThis & { __hubDnsResolve?: Resolve | null };

/**
 * Подмена разрешения имён в тестах: имена вида *.example в настоящем DNS не разрешаются.
 * null возвращает системное разрешение.
 */
export function setDnsResolverForTests(resolve: Resolve | null): void {
  shared.__hubDnsResolve = resolve;
}

const invalid = () => new HduError('invalid_input');

/**
 * Проверяет адрес сервера Smartup и возвращает его разобранным. Бросает HduError('invalid_input').
 *
 * allowLoopback: портал сам работает на localhost (разработка и тесты). Тогда допускаются
 * http и https на localhost и 127.0.0.1, например ложный сервер входа. Остальные правила не меняются.
 */
export async function assertPublicUrl(raw: string, opts: { allowLoopback: boolean; resolve?: Resolve }): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (url.username || url.password) throw invalid();
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

  if (opts.allowLoopback && LOOPBACK_HOSTS.has(host) && (url.protocol === 'http:' || url.protocol === 'https:')) return url;
  if (url.protocol !== 'https:') throw invalid();
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw invalid();

  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw invalid();
    return url;
  }
  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? shared.__hubDnsResolve ?? systemResolve)(host);
  } catch {
    throw invalid();
  }
  // Имя, которое не разрешается, тоже отклоняется: проверить его нельзя.
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw invalid();
  return url;
}

/** Работает ли сам портал на localhost: тогда локальные серверы входа допустимы. */
export function isLocalPortal(hubUrl: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(hubUrl).hostname);
}
