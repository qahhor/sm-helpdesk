import 'server-only';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { withActor } from '@/db/with-actor';
import type { RateRule } from './pref';
import { rateLimits } from './schema';

// Ограничение частоты (ТЗ 14.5). Счётчики хранятся в PostgreSQL и работают одинаково
// для всех экземпляров приложения. Библиотека входа свои вызовы не считает (решение 0012): считает портал.

const SYSTEM = { type: 'system', job: 'rate-limit' } as const;

/**
 * Ключ счётчика: вид действия и хеш того, кого считаем. Адрес, учётная запись и IP
 * в таблицу в открытом виде не попадают. Написание (регистр, пробелы) на ключ не влияет.
 */
export function rateKey(scope: string, value: string): string {
  const digest = createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  return `${scope}:${digest.slice(0, 32)}`;
}

/**
 * Учитывает попытку и говорит, укладывается ли она в предел.
 *
 * Окно истекло: счёт начинается заново. Попытка, которая первой превысила предел, начинает окно заново:
 * блокировка длится полное окно с этого момента. Следующие попытки во время блокировки её не продлевают.
 * Одна команда базы: одновременные попытки считаются без потерь.
 */
export async function consumeRateLimit(
  key: string,
  rule: RateRule,
  now: Date = new Date(),
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const at = now.toISOString();
  const expired = sql`${rateLimits.windowOn} + make_interval(secs => ${rule.windowSec}) <= ${at}::timestamptz`;
  const rows = await withActor(SYSTEM, (tx) =>
    tx
      .insert(rateLimits)
      .values({ code: key, windowOn: now, hits: 1 })
      .onConflictDoUpdate({
        target: rateLimits.code,
        set: {
          hits: sql`case when ${expired} then 1 else ${rateLimits.hits} + 1 end`,
          windowOn: sql`case when ${expired} then ${at}::timestamptz
                             when ${rateLimits.hits} = ${rule.limit} then ${at}::timestamptz
                             else ${rateLimits.windowOn} end`,
        },
      })
      .returning({ hits: rateLimits.hits, windowOn: rateLimits.windowOn }),
  );
  const row = rows[0];
  if (!row) throw new Error('Счётчик частоты не вернул строку');
  if (row.hits <= rule.limit) return { allowed: true, retryAfterSec: 0 };
  const until = row.windowOn.getTime() + rule.windowSec * 1000;
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((until - now.getTime()) / 1000)) };
}

/** Обнуляет счётчик, например после успешного входа. */
export async function resetRateLimit(key: string): Promise<void> {
  await withActor(SYSTEM, (tx) => tx.delete(rateLimits).where(eq(rateLimits.code, key)));
}
