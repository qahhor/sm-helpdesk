// Модуль hdp, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

/** Номер проблемы для показа: KP-12 (раздел 8.12). */
export function problemRef(number: number): string {
  return `KP-${number}`;
}

/** Номер из записи KP-12, kp 12 или 12; иначе null. */
export function parseProblemRef(value: string): number | null {
  const match = /^\s*(?:kp[-\s]?)?(\d{1,9})\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 ? number : null;
}
