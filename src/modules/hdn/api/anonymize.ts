import 'server-only';
import { and, arrayOverlaps, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { writeAudit } from '@/modules/hdc/api';
import { emailInbound, outbox } from '../schema';

// Модуль hdn, слой api: следы обезличенной учётной записи в почте портала (ТЗ 14.6; проверка W7, находка R3;
// решение 0162). Вызывает модуль пользователей hdu сразу после обезличивания, от имени системы: очередь и входящие
// письма меняет только система (политики hdn_outbox_system_update и hdn_email_inbound_system_update), права не
// расширялись. Одной транзакцией с записью user.mail_anonymized.
//   - Очередь исходящих, строки этого получателя: ждущие снимаются (skipped), адрес получателя стирается, данные
//     письма сводятся к названию шаблона (его требует ограничение hdn_outbox_c6).
//   - Разобранные входящие письма: адрес и имя отправителя заменяются, заголовки стираются, адрес убирается из
//     получателей и копий чужих писем. Письмо, которое ещё ждёт разбора, не трогается: разбор читает из строки
//     отправителя. Тема письма остаётся: это текст обращения. Ссылка raw_ref остаётся: по ней повтор вебхука узнаёт
//     уже принятое письмо, а копию письма у почтовой службы портал не удаляет (остаток записан в решении 0162).
// Повтор безопасен: второй вызов не находит, что менять, и записи в журнал не делает.

/** Адрес отправителя обезличенного входящего письма. Домен .invalid не доставляется никуда (RFC 2606). */
export const ANONYMIZED_SENDER = 'anonymized@anonymized.invalid';

const input = z.strictObject({ userId: z.uuid(), addresses: z.array(z.string().trim().toLowerCase().min(3).max(320)).max(4) });

export async function forgetMailTraces(system: SystemActor, raw: unknown): Promise<{ outbox: number; inbound: number }> {
  if (system?.type !== 'system') throw new Error('hdn: следы почты стирает только система');
  const { userId, addresses } = input.parse(raw);
  return withActor(system, async (tx) => {
    const bare = sql`jsonb_build_object('template', ${outbox.template})`;
    const queue = await tx
      .update(outbox)
      .set({ status: sql`case when ${outbox.status} = 'queued' then 'skipped' else ${outbox.status} end`, recipient: null, payload: bare })
      .where(and(eq(outbox.recipientUserId, userId), or(eq(outbox.status, 'queued'), isNotNull(outbox.recipient), ne(outbox.payload, bare))))
      .returning({ outboxId: outbox.outboxId });
    let inbound = 0;
    if (addresses.length > 0) {
      const own = inArray(emailInbound.fromAddress, addresses);
      // Массив значений drizzle раскрывает в список параметров: массив базы собирается явно.
      const list = sql`array[${sql.join(addresses.map((address) => sql`${address}`), sql`, `)}]::text[]`;
      const without = (column: typeof emailInbound.toAddresses | typeof emailInbound.ccAddresses) => sql<string[]>`(select coalesce(array_agg(a), '{}') from unnest(${column}) as a where a <> all(${list}))`;
      const rows = await tx
        .update(emailInbound)
        .set({
          fromAddress: sql`case when ${own} then ${ANONYMIZED_SENDER} else ${emailInbound.fromAddress} end`,
          fromName: sql`case when ${own} then null else ${emailInbound.fromName} end`,
          headers: null,
          toAddresses: without(emailInbound.toAddresses),
          ccAddresses: without(emailInbound.ccAddresses),
        })
        .where(and(isNotNull(emailInbound.processedOn), or(own, arrayOverlaps(emailInbound.toAddresses, addresses), arrayOverlaps(emailInbound.ccAddresses, addresses))))
        .returning({ inboundId: emailInbound.inboundId });
      inbound = rows.length;
    }
    if (queue.length + inbound > 0) await writeAudit(tx, { action: 'user.mail_anonymized', objectType: 'user', objectId: userId, diff: { outbox: queue.length, inbound } });
    return { outbox: queue.length, inbound };
  });
}
