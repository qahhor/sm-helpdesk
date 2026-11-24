import * as z from 'zod';
import { logEvent } from '@/lib/log';
import { BlockedAddressError, createGuardedFetch, type GuardedPost, guardedPostJson, OutboundTimeoutError } from '@/security/outbound';
import { devTaskUrlOrNull } from '../dev-task-url';
import { DEV_TASK_REF_MAX, DEV_TASK_VERSION_MAX } from '../pref';
import { mapTrackerStatus } from './status-map';
import type { DevTracker } from './types';

// Модуль hdw: реализация DevTracker для API таск-менеджера Smartup (FR-DEV-03, 04; план M8, задача 8, решение 13).
//
// ВНИМАНИЕ: ЭТО ЗАГОТОВКА. Описание настоящего API таск-менеджера Smartup не получено (ТЗ, раздел 17, задача 9).
// Адреса, поля, способ входа и перечень статусов здесь это ПРЕДПОЛАГАЕМЫЙ договор из docs/integrations/dev-tracker.md,
// проверенный только против ложного сервера scripts/mock-tracker.mjs. Когда придёт настоящее описание, меняются
// только этот файл, status-map.ts, tracker-sign.ts и ложный сервер: интерфейс DevTracker и всё, что стоит над ним,
// от договора не зависят.
//
// Запросы идут через защищённый сетевой слой (src/security/outbound.ts): только https, имя узла проверяется при
// соединении и внутренние адреса отклоняются, переадресации не выполняются, на ответ 10 секунд. http на localhost
// допускается, только когда сам портал работает на localhost (ложный сервер в разработке и тестах).

export const TRACKER_TIMEOUT_MS = 10_000;
/** Ответ таск-менеджера на создание и чтение задачи короткий: больше этого не читается. */
const RESPONSE_MAX_BYTES = 16 * 1024;

/**
 * Таск-менеджер не ответил или ответил не по договору. code: timeout, blocked_address, unreachable, http_<код>,
 * bad_response. Текста ответа в ошибке нет.
 */
export class DevTrackerUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Таск-менеджер недоступен: ${code}`);
    this.name = 'DevTrackerUnavailableError';
    this.code = code;
  }
}

/** Задача есть, но её статус порталу незнаком: статус задачи в портале не меняется. */
export class DevTrackerUnknownStatusError extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super('Таск-менеджер вернул незнакомый статус задачи');
    this.name = 'DevTrackerUnknownStatusError';
    this.ref = ref;
  }
}

export type SmartupTrackerConfig = {
  /** Адрес API без косой черты в конце. */
  baseUrl: string;
  token: string;
  /** Портал сам работает на localhost: допускается http на localhost и 127.0.0.1. */
  allowLoopback: boolean;
  timeoutMs?: number;
  /** Подмена запросов в тестах. */
  post?: GuardedPost;
  fetch?: typeof fetch;
};

const refField = z
  .string()
  .min(1)
  .max(DEV_TASK_REF_MAX)
  .regex(/^[^\s\p{Cc}]+$/u);
const createdResponse = z.object({ ref: refField, url: z.string().min(1).max(2000) });
const taskResponse = z.object({ ref: refField, url: z.string().min(1).max(2000), status: z.string().max(60), version: z.string().trim().max(DEV_TASK_VERSION_MAX).nullish() });

const failureCode = (error: unknown): string =>
  error instanceof DevTrackerUnavailableError
    ? error.code
    : error instanceof OutboundTimeoutError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
      ? 'timeout'
      : error instanceof BlockedAddressError
        ? 'blocked_address'
        : 'unreachable';

function parseJson(text: string | undefined): unknown {
  if (text === undefined) throw new DevTrackerUnavailableError('bad_response');
  try {
    return JSON.parse(text);
  } catch {
    throw new DevTrackerUnavailableError('bad_response');
  }
}

/** Тело ответа не длиннее предела. Длиннее: ответ не по договору. */
async function limitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new DevTrackerUnavailableError('bad_response');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createSmartupTracker(cfg: SmartupTrackerConfig): DevTracker {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? TRACKER_TIMEOUT_MS;
  const guard = { allowLoopback: cfg.allowLoopback };
  const post = cfg.post ?? guardedPostJson;
  const get = cfg.fetch ?? createGuardedFetch(guard);
  const auth = { authorization: `Bearer ${cfg.token}` };
  /** Адрес задачи из ответа показывается сотруднику ссылкой: только https (или localhost рядом с локальным порталом). */
  const linkOf = (raw: string): string => {
    const url = devTaskUrlOrNull(raw, cfg.allowLoopback);
    if (!url) throw new DevTrackerUnavailableError('bad_response');
    return url;
  };
  /** Сбой записывается в журнал кодом: текста ответа и токена в журнале нет. */
  const failed = (op: 'create' | 'get', error: unknown): DevTrackerUnavailableError => {
    const code = failureCode(error);
    logEvent('warn', 'devtask.tracker_failed', { op, error: code });
    return error instanceof DevTrackerUnavailableError ? error : new DevTrackerUnavailableError(code);
  };

  return {
    async createTask(input) {
      try {
        const body = JSON.stringify({
          title: input.title,
          descriptionMd: input.descriptionMd,
          kind: input.kind,
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.moduleCode !== undefined ? { moduleCode: input.moduleCode } : {}),
          sourceUrl: input.sourceUrl,
        });
        const response = await post(guard, `${base}/tasks`, { body, headers: { ...auth, accept: 'application/json' }, timeoutMs, maxResponseBytes: RESPONSE_MAX_BYTES, readBody: true });
        if (response.status !== 200 && response.status !== 201) throw new DevTrackerUnavailableError(`http_${response.status}`);
        const parsed = createdResponse.safeParse(parseJson(response.body));
        if (!parsed.success) throw new DevTrackerUnavailableError('bad_response');
        return { ref: parsed.data.ref, url: linkOf(parsed.data.url) };
      } catch (error) {
        throw failed('create', error);
      }
    },

    async getTask(ref) {
      let raw: z.infer<typeof taskResponse>;
      try {
        const response = await get(`${base}/tasks/${encodeURIComponent(ref)}`, { headers: { ...auth, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 404) {
          await response.body?.cancel().catch(() => {});
          return null;
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          throw new DevTrackerUnavailableError(`http_${response.status}`);
        }
        const parsed = taskResponse.safeParse(parseJson(await limitedText(response)));
        if (!parsed.success) throw new DevTrackerUnavailableError('bad_response');
        raw = parsed.data;
      } catch (error) {
        throw failed('get', error);
      }
      const status = mapTrackerStatus(raw.status);
      if (!status) {
        // Незнакомый статус ничего не меняет (решение 13): в журнале сам статус, он не секрет и не текст клиента.
        logEvent('warn', 'devtask.unknown_status', { ref: raw.ref, status: raw.status.slice(0, 60) });
        throw new DevTrackerUnknownStatusError(raw.ref);
      }
      return { ref: raw.ref, url: linkOf(raw.url), status, ...(raw.version ? { version: raw.version } : {}) };
    },
  };
}
