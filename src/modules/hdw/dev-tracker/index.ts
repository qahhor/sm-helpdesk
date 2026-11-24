import 'server-only';
import { getEnv } from '@/env';
import { LOOPBACK_HOSTS } from '@/security/outbound';
import type { DevTrackerKind } from '../pref';
import { createManualTracker } from './manual';
import { createSmartupTracker } from './smartup';
import type { DevTracker } from './types';

// Модуль hdw: выбор таск-менеджера по окружению (FR-DEV-01; решение 13 плана M8). DEV_TRACKER=manual (по умолчанию):
// номер и ссылку задачи вводит сотрудник, портал никуда не обращается. DEV_TRACKER=smartup: задачи создаёт портал
// через API таск-менеджера Smartup (заготовка против предполагаемого договора: docs/integrations/dev-tracker.md).

export type DevTrackerSettings =
  | { mode: 'manual' }
  | {
      mode: 'smartup';
      /** Адрес API таск-менеджера. */
      url: string;
      token: string;
      /** Общий секрет подписи входящего вебхука. */
      webhookSecret: string;
      /** Срок ответа таск-менеджера, мс: по умолчанию 10 секунд. */
      timeoutMs?: number;
    };

let override: { settings: DevTrackerSettings; tracker?: DevTracker } | null = null;
let real: { key: string; tracker: DevTracker } | undefined;

/** Настройки таск-менеджера из окружения. Полноту набора для режима smartup проверяет src/env.ts при запуске. */
export function devTrackerSettings(): DevTrackerSettings {
  if (override) return override.settings;
  const env = getEnv();
  if (env.DEV_TRACKER !== 'smartup') return { mode: 'manual' };
  if (!env.DEV_TRACKER_URL || !env.DEV_TRACKER_TOKEN || !env.DEV_TRACKER_WEBHOOK_SECRET) throw new Error('Таск-менеджер: режим smartup без адреса, токена или секрета вебхука');
  return { mode: 'smartup', url: env.DEV_TRACKER_URL, token: env.DEV_TRACKER_TOKEN, webhookSecret: env.DEV_TRACKER_WEBHOOK_SECRET };
}

/** Режим работы с таск-менеджером: от него зависит форма передачи в разработку и то, кто меняет статус задачи. */
export function devTrackerMode(): DevTrackerKind {
  return devTrackerSettings().mode;
}

function build(settings: DevTrackerSettings): DevTracker {
  if (settings.mode === 'manual') return createManualTracker();
  return createSmartupTracker({
    baseUrl: settings.url,
    token: settings.token,
    // http на localhost допускается, только когда сам портал работает на localhost (ложный сервер в разработке).
    allowLoopback: LOOPBACK_HOSTS.has(new URL(getEnv().HUB_URL).hostname),
    ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
  });
}

export function getDevTracker(): DevTracker {
  if (override?.tracker) return override.tracker;
  const settings = devTrackerSettings();
  const key = JSON.stringify(settings);
  if (real?.key !== key) real = { key, tracker: build(settings) };
  return real.tracker;
}

/**
 * Тесты подменяют настройки таск-менеджера и, если нужно, саму реализацию (null возвращает настоящие). Без tracker
 * реализация строится из подменённых настроек: так контрактные тесты ведут настоящую реализацию на ложный сервер.
 */
export function setDevTrackerForTests(value: { settings: DevTrackerSettings; tracker?: DevTracker } | null): void {
  override = value;
  real = undefined;
}

export type { DevTracker, DevTrackerTask, DevTrackerTaskInput } from './types';
