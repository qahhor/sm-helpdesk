import { workerReadyResponse } from '@/modules/hdc/api';

// Фоновый процесс работает: его отметка не старше 3 минут (план подготовки M9, задача 3, решение 5). Проверку вызывает
// внешняя проверка доступности. Caddy делит запросы по /api/ready: сбой фонового процесса портал не снимает.
export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return workerReadyResponse();
}
