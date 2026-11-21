import 'server-only';
import { env } from '@/env';
import { createClamavScanner } from './clamav';
import { createStubScanner } from './stub';
import type { AntivirusScanner } from './types';

// Выбор антивируса по окружению (решение 0027): ClamAV при заданном CLAMAV_HOST, иначе заглушка.
// На настоящем адресе в production портал без CLAMAV_HOST не запускается (src/env.ts).

let override: AntivirusScanner | null = null;
let real: AntivirusScanner | undefined;

export function getScanner(): AntivirusScanner {
  if (override) return override;
  return (real ??= env.CLAMAV_HOST ? createClamavScanner({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT }) : createStubScanner());
}

/** Тесты подменяют антивирус (null возвращает настоящий). */
export function setScannerForTests(scanner: AntivirusScanner | null): void {
  override = scanner;
}

export type { AntivirusScanner } from './types';
