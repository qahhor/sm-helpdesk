import 'server-only';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import type { InboundClass } from '@/modules/hdn/api/inbound';
import { intakeEmailTx } from '../core/email-intake';

// Модуль hdt, слой api: разбор входящего письма (задача email.inbound). Вызывает только система. Узкий файл: его берёт
// фоновый процесс, без страниц и Next.js.

const inboundIdInput = z.uuid();

export async function intakeEmail(actor: SystemActor, inboundId: unknown): Promise<InboundClass> {
  if (actor.type !== 'system') throw new Error('Разбор писем выполняет только система');
  return intakeEmailTx(actor, inboundIdInput.parse(inboundId));
}
