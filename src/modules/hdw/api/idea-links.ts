import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { getEnv } from '@/env';
import { logEvent } from '@/lib/log';
import type { StaffContext } from '@/modules/hdc/api';
import { LOOPBACK_HOSTS } from '@/security/outbound';
import { devTaskUrlOrNull } from '../dev-task-url';
import { devTaskByRefTx, type LinkInput } from '../core/dev-tasks';
import { devTrackerMode, getDevTracker } from '../dev-tracker';
import { HdwError } from '../error';
import { DEV_TASK_REF_MAX, DEV_TASK_TITLE_MAX } from '../pref';

// Модуль hdw, слой api: передача выбранной идеи в разработку тем же адаптером, что и обращения (ТЗ FR-IDEA-12,
// FR-DEV-06; план M7, задача 9, решение 18). Модуль идей hdi сам проверяет роль (product, admin) и статус идеи,
// здесь только задача: в ручном режиме номер, ссылка и название из формы, в режиме API задача создаётся или находится
// в таск-менеджере Smartup вне транзакции. Затем hdi в своей транзакции вызывает linkIdeaTx и ставит статус идеи.
// В таск-менеджер уходят заголовок и описание идеи и ссылка на карточку: без автора, организации и комментариев.

export { devTaskOfIdeaTx, linkIdeaTx, type DevTask, type LinkInput } from '../core/dev-tasks';
export type { ClosedDevTask } from '../core/idea-hook';
export { isHdwError, type HdwErrorCode } from '../error';

const externalId = z
  .string()
  .trim()
  .min(1)
  .max(DEV_TASK_REF_MAX)
  .regex(/^[^\s\p{Cc}]+$/u);
const manualInput = z.strictObject({ externalId, url: z.string().max(4000), title: z.string().trim().min(1).max(DEV_TASK_TITLE_MAX) });
const apiInput = z.strictObject({ externalId: externalId.optional() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HdwError('invalid_input');
  return parsed.data;
}

const localPortal = (): boolean => LOOPBACK_HOSTS.has(new URL(getEnv().HUB_URL).hostname);

/** Что уходит в таск-менеджер о выбранной идее: номер для ссылки на карточку, заголовок и описание оригинала. */
export type IdeaTaskSource = { number: number; title: string; body: string };

/**
 * Задача для привязки идеи. Ручной режим: номер, ссылка (https, http только на localhost у локального портала) и
 * название. Режим API: известная порталу задача по номеру, задача из таск-менеджера по номеру или новая задача.
 * Отказы: invalid_input, invalid_url, task_not_found, tracker_unavailable.
 */
export async function resolveIdeaTaskLink(ctx: StaffContext, input: unknown, source: IdeaTaskSource): Promise<{ link: LinkInput; remoteCreated: boolean }> {
  if (devTrackerMode() !== 'smartup') {
    const data = parse(manualInput, input);
    const url = devTaskUrlOrNull(data.url, localPortal());
    if (!url) throw new HdwError('invalid_url');
    return { link: { tracker: 'manual', externalId: data.externalId, url, title: data.title }, remoteCreated: false };
  }
  const data = parse(apiInput, input);
  const tracker = getDevTracker();
  if (data.externalId) {
    const ref = data.externalId;
    const known = await withActor(ctx.actor, (tx) => devTaskByRefTx(tx, 'smartup', ref));
    if (known) return { link: { tracker: 'smartup', externalId: known.externalId, url: known.url, title: known.title }, remoteCreated: false };
    let remote: Awaited<ReturnType<typeof tracker.getTask>>;
    try {
      remote = await tracker.getTask(ref);
    } catch {
      throw new HdwError('tracker_unavailable');
    }
    if (!remote) throw new HdwError('task_not_found');
    const url = devTaskUrlOrNull(remote.url, localPortal());
    if (!url) throw new HdwError('tracker_unavailable');
    return { link: { tracker: 'smartup', externalId: remote.ref, url, title: '', status: remote.status, version: remote.version ?? null }, remoteCreated: false };
  }
  const sourceUrl = `${getEnv().HUB_URL}/ru/agent/ideas/I-${source.number}`;
  let created: { ref: string; url: string };
  try {
    created = await tracker.createTask({ title: source.title, descriptionMd: `${source.body}\n\n---\nSmartup Hub: ${sourceUrl}`, kind: 'feature', sourceUrl });
  } catch {
    throw new HdwError('tracker_unavailable');
  }
  const url = devTaskUrlOrNull(created.url, localPortal());
  if (!url) {
    logEvent('error', 'devtask.orphan', { ref: created.ref, ideaNumber: source.number });
    throw new HdwError('tracker_unavailable');
  }
  // Задача создана до транзакции привязки: если привязка не пройдёт, номер осиротевшей задачи пишет вызывающий
  // (remoteCreated), чтобы её нашли и закрыли или привязали вручную.
  return { link: { tracker: 'smartup', externalId: created.ref, url, title: source.title.trim().slice(0, DEV_TASK_TITLE_MAX).trim() }, remoteCreated: true };
}
