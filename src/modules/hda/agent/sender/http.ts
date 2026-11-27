import 'server-only';
import { guardedPostJson, LOOPBACK_HOSTS } from '@/security/outbound';
import type { AgentEventSender } from './types';

// Настоящая отправка событий AI-сотрудника: POST JSON на AGENT_WEBHOOK_URL общим защищённым запросом портала (только
// https, без переадресаций и внутренних адресов, 10 секунд на всё). Принято: ответ 2xx. Тело ответа не читается.

const TIMEOUT_MS = 10_000;

export function createHttpAgentEventSender(hubUrl: string): AgentEventSender {
  const allowLoopback = LOOPBACK_HOSTS.has(new URL(hubUrl).hostname);
  return {
    async send(input) {
      try {
        const result = await guardedPostJson({ allowLoopback }, input.url, { body: input.body, headers: input.headers, timeoutMs: TIMEOUT_MS });
        return { ok: result.status >= 200 && result.status < 300, status: result.status };
      } catch {
        return { ok: false, status: null };
      }
    },
  };
}
