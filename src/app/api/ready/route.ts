import { isDatabaseReady } from '@/modules/hdc/api';
import { readyResponse } from '@/modules/hdc/util';

// Приложение готово принимать запросы: база отвечает. Проверку вызывает выкладка и наблюдение.
export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return readyResponse(() => isDatabaseReady());
}
