import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { AGENT_TOKEN_BYTES, AGENT_TOKEN_PREFIX } from '../pref';

// Токен AI-сотрудника и адреса (веха M8b, задача 3; FR-AGT-02; план M8b, решения 10, 11). Чистые функции без базы.
// Значение токена показывается администратору один раз, в базе только SHA-256: значение случайное, медленный хеш не
// нужен. Адрес запроса сверяется со списком сетей токена (и общим MCP_ALLOWED_IPS на входе сервера MCP, задача 4).

/** Вид значения: приставка и 32 байта base64url без дополнения (43 знака). */
const TOKEN_VALUE = new RegExp(`^${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

export function generateTokenValue(): string {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(AGENT_TOKEN_BYTES).toString('base64url')}`;
}

export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Последние 4 знака значения: администратор узнаёт токен в списке. */
export function tokenLast4(value: string): string {
  return value.slice(-4);
}

/** Значение из заголовка "Authorization: Bearer <значение>". Другой вид, лишнее или значение не нашего вида: null. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  const value = match?.[1];
  return value && TOKEN_VALUE.test(value) ? value : null;
}

type Address = { bytes: number[]; v4: boolean };

/** Адрес без порта и скобок: "10.0.3.12:51234", "[2001:db8::1]:443". IPv4 внутри IPv6 (::ffff:a.b.c.d) как IPv4. */
function parseAddress(raw: string): Address | null {
  let text = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(':'));
  const version = isIP(text);
  if (version === 4) return { bytes: text.split('.').map(Number), v4: true };
  if (version !== 6) return null;
  const bytes = ipv6Bytes(text);
  if (!bytes) return null;
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? { bytes: bytes.slice(12), v4: true } : { bytes, v4: false };
}

function ipv6Bytes(text: string): number[] | null {
  let source = text.toLowerCase();
  // Хвост IPv4 ("::ffff:10.0.3.12") переводится в две группы.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(source);
  if (tail) {
    const parts = tail[1]!.split('.').map(Number);
    source = `${source.slice(0, -tail[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head, rest] = source.split('::');
  const left = head ? head.split(':') : [];
  const right = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? left.length !== 8 : missing < 1) return null;
  const groups = [...left, ...Array(rest === undefined ? 0 : missing).fill('0'), ...right];
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function formatIpv6(bytes: number[]): string {
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!).toString(16));
  // Самая длинная серия нулей (от двух групп) сжимается в "::".
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j += 1;
    if (j - i > best.length) best = { start: i, length: j - i };
    i = j;
  }
  if (best.length < 2) return groups.join(':');
  return `${groups.slice(0, best.start).join(':')}::${groups.slice(best.start + best.length).join(':')}`;
}

type Network = { bytes: number[]; v4: boolean; prefix: number };

function parseNetwork(raw: string): Network | null {
  const [address, prefixText, extra] = raw.trim().split('/');
  if (extra !== undefined || !address) return null;
  const version = isIP(address);
  if (version === 0) return null;
  const parsed = version === 4 ? { bytes: address.split('.').map(Number), v4: true } : ipv6Bytes(address) && { bytes: ipv6Bytes(address)!, v4: false };
  if (!parsed) return null;
  const max = parsed.v4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (prefix > max) return null;
  return { ...parsed, prefix };
}

function masked(bytes: number[], prefix: number): number[] {
  return bytes.map((byte, i) => {
    const bits = Math.min(8, Math.max(0, prefix - i * 8));
    return byte & ((0xff << (8 - bits)) & 0xff);
  });
}

/**
 * Сеть для списка адресов токена в виде, который примет колонка cidr: адрес без маски даёт /32 или /128, биты адреса
 * за маской обнуляются. Неверная запись: null.
 */
export function normalizeCidr(raw: string): string | null {
  const network = parseNetwork(raw);
  if (!network) return null;
  const start = masked(network.bytes, network.prefix);
  const address = raw.trim().split('/')[0]!.toLowerCase();
  const same = start.every((byte, i) => byte === network.bytes[i]);
  const text = same ? address : network.v4 ? start.join('.') : formatIpv6(start);
  return `${text}/${network.prefix}`;
}

/** Входит ли адрес запроса хотя бы в одну сеть списка. Неверный адрес или пустой список: нет. */
export function ipAllowed(ip: string | null | undefined, cidrs: readonly string[]): boolean {
  if (!ip) return false;
  const address = parseAddress(ip);
  if (!address) return false;
  return cidrs.some((cidr) => {
    const network = parseNetwork(cidr);
    if (!network || network.v4 !== address.v4) return false;
    const a = masked(address.bytes, network.prefix);
    const n = masked(network.bytes, network.prefix);
    return a.every((byte, i) => byte === n[i]);
  });
}
