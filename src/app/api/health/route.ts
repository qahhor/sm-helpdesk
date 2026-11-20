import { healthResponse } from '@/modules/hdc/util';

// Процесс жив. Проверку вызывает оркестратор контейнеров (scripts/healthcheck.mjs).
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return healthResponse();
}
