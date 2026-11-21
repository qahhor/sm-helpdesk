// Чтение кук из заголовка Cookie. Файл без 'server-only': его загружает и прокси.

/** Значение куки как оно пришло, без раскодирования. Нет куки: undefined. */
export function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const pair = part.trim();
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}
