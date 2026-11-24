import { vi } from 'vitest';
import { setOutboundFetchForTests } from '@/security/outbound';

/**
 * Подмена исходящего запроса портала к серверу Smartup (проверка связи): ответ задаётся как у vi.spyOn.
 * Запросы идут не через общий fetch, а через сетевой слой src/security/outbound.ts, поэтому подменяется он.
 * mockRestore возвращает настоящий запрос.
 */
export function spyOutbound() {
  const spy = vi.fn<typeof globalThis.fetch>();
  setOutboundFetchForTests((input, init) => spy(input, init));
  return Object.assign(spy, { mockRestore: () => setOutboundFetchForTests(null) });
}
