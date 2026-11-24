import { isIP } from 'node:net';
import { Agent, type Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { BlockedAddressError, guardedLookup, isPrivateAddress, LOOPBACK_HOSTS, resolverFor } from './outbound';

// Проверка адреса при соединении для запросов, которые делает не код портала, а библиотека входа: обмен кода на
// токен, ключи подписи, сведения о пользователе (аудит 23.11.2026, остаток находки S14; решение 0041, вопрос 18).
// Библиотека ходит общим fetch и своего сетевого слоя не принимает. Общий fetch Node.js берёт диспетчер запросов
// процесса, поэтому проверка стоит в нём. Она действует только на узлы серверов Smartup из реестра: хранилище,
// почтовый сервис и Telegram идут как раньше, им внутренний адрес бывает положен (хранилище в своей сети).
// Имя узла разрешается тем же вызовом, который отдаёт адрес сокету: подмена ответа DNS между проверкой при записи
// сервера в реестр и соединением больше не проходит.

const shared = globalThis as typeof globalThis & {
  __hubGuardedHosts?: Set<string>;
  __hubOutboundGuard?: { base: Dispatcher; allowLoopback: boolean };
};
const hosts = (): Set<string> => (shared.__hubGuardedHosts ??= new Set());

const hostOfOrigin = (origin: string | URL): string => {
  const { hostname } = new URL(String(origin));
  return hostname.startsWith('[') ? hostname.slice(1, -1).toLowerCase() : hostname.toLowerCase();
};

/** Узлы серверов Smartup: адрес сервера и его адреса из реестра. Вызывается при сборке настроек входа. */
export function setGuardedOrigins(origins: readonly string[]): void {
  const set = hosts();
  set.clear();
  for (const origin of origins) set.add(hostOfOrigin(origin));
}

export function guardedHostsForTests(): string[] {
  return [...hosts()];
}

/**
 * Ставит диспетчер запросов процесса. allowLoopback: портал сам работает на localhost (разработка и тесты), тогда
 * ложный сервер входа на localhost допускается. Повторный вызов меняет только этот признак.
 */
export function installOutboundGuard(cfg: { allowLoopback: boolean }): void {
  const base = shared.__hubOutboundGuard?.base ?? getGlobalDispatcher();
  shared.__hubOutboundGuard = { base, allowLoopback: cfg.allowLoopback };
  const guarded = new Agent({ connect: { lookup: guardedLookup(resolverFor()) } });
  setGlobalDispatcher(
    base.compose((dispatch) => (opts, handler) => {
      const host = opts.origin ? hostOfOrigin(opts.origin) : '';
      if (!hosts().has(host)) return dispatch(opts, handler);
      if (shared.__hubOutboundGuard?.allowLoopback && LOOPBACK_HOSTS.has(host)) return dispatch(opts, handler);
      // Адрес цифрами имя не разрешает: проверяется сам адрес.
      if (isIP(host) !== 0 && isPrivateAddress(host)) throw new BlockedAddressError();
      return guarded.dispatch(opts, handler);
    }),
  );
}
