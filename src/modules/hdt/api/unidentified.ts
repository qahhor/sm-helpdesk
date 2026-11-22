import 'server-only';
import * as z from 'zod';
import { domainHint, findVerifiedUser, guestSenders, SERVICE_ORG_ID } from '@/modules/hdu/api/guests';
import { mailRecipient } from '@/modules/hdu/api/recipients';
import { addGuestMembership } from '@/modules/hdu/api/guests';
import { getOrganization, inviteGuest, isHduError, type StaffContext } from '@/modules/hdu/api';
import { assertCanWrite } from '../core/agent-actions';
import { bindTicketTx, closeUnidentifiedTx, ticketAuthorTx, UNIDENTIFIED_PAGE_SIZE, unidentifiedCountTx, unidentifiedRowsTx } from '../core/unidentified';
import { HdtError } from '../error';
import { numberInput, parseInput } from '../input';

// Модуль hdt, слой api: очередь "Неопознанные" (FR-EM-04, решения 12-14 вехи M4, экран по образцу 8.12). Список видят
// все сотрудники-люди; привязывают, приглашают и закрывают роли, которые ведут обращения (product только смотрит).

export type UnidentifiedItem = {
  number: number;
  title: string;
  fromAddress: string | null;
  fromName: string | null;
  createdOn: Date;
  /** Организация клиента по домену адреса (hdu_org_email_domains). */
  hint: { orgId: string; name: string } | null;
  /** Адрес принадлежит подтверждённому пользователю портала, а письмо пришло без DMARC: возможна подделка. */
  addressOwned: boolean;
};

const listInput = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });
const bindInput = z.object({ number: numberInput, orgId: z.uuid() });

export async function listUnidentified(ctx: StaffContext, input: unknown = {}): Promise<{ items: UnidentifiedItem[]; count: number; hasMore: boolean }> {
  const { page } = parseInput(listInput, input ?? {});
  const { rows, count } = await unidentifiedRowsTx(ctx.actor, page);
  const shown = rows.slice(0, UNIDENTIFIED_PAGE_SIZE);
  const senders = await guestSenders(shown.map((r) => r.authorId));
  const items = await Promise.all(
    shown.map(async (row) => {
      const sender = senders.get(row.authorId);
      // Автор уже не гость (его обращения перешли пользователю): адрес для писем этого пользователя.
      const fromAddress = sender?.address ?? (await mailRecipient(row.authorId))?.address ?? null;
      return {
        number: row.number,
        title: row.title,
        fromAddress,
        fromName: sender?.name ?? null,
        createdOn: row.createdOn,
        hint: fromAddress ? await domainHint(fromAddress) : null,
        addressOwned: sender ? (await findVerifiedUser(sender.address)) !== null : false,
      };
    }),
  );
  return { items, count, hasMore: rows.length > UNIDENTIFIED_PAGE_SIZE };
}

export function unidentifiedCount(ctx: StaffContext): Promise<number> {
  return unidentifiedCountTx(ctx.actor);
}

/** Приглашение гостю; сбой не отменяет уже сделанную привязку, сотрудник повторит его кнопкой (решение 13). */
async function tryInvite(ctx: StaffContext, guestUserId: string, orgId: string): Promise<boolean> {
  try {
    await inviteGuest(ctx, { guestUserId, orgId });
    return true;
  } catch (error) {
    console.error(`Приглашение отправителю письма не создано: ${error instanceof Error ? error.message : 'ошибка'}`);
    return false;
  }
}

/** "Привязать и пригласить": обращение в организацию клиента, гостю членство guest и приглашение на адрес из письма. */
export async function bindTicket(ctx: StaffContext, input: unknown): Promise<{ invited: boolean }> {
  assertCanWrite(ctx.actor);
  const { number, orgId } = parseInput(bindInput, input);
  const org = await getOrganization(ctx, orgId);
  if (!org || org.state !== 'active') throw new HdtError('not_found');
  const { authorId } = await bindTicketTx(ctx.actor, number, orgId);
  if (!(await guestSenders([authorId])).has(authorId)) return { invited: false };
  await addGuestMembership(authorId, orgId);
  return { invited: await tryInvite(ctx, authorId, orgId) };
}

/**
 * "Пригласить отправителя": повтор приглашения после сбоя или приглашение отправителя, которого определили по домену
 * (отметка "отправитель не подтверждён"). Прежнее ждущее приглашение заменяется: остаётся одно.
 */
export async function inviteSender(ctx: StaffContext, numberValue: unknown): Promise<{ invited: boolean }> {
  assertCanWrite(ctx.actor);
  const number = parseInput(numberInput, numberValue);
  const ticket = await ticketAuthorTx(ctx.actor, number);
  if (!ticket) throw new HdtError('not_found');
  if (ticket.orgId === SERVICE_ORG_ID) throw new HdtError('transition_refused');
  if (!(await guestSenders([ticket.authorId])).has(ticket.authorId)) throw new HdtError('transition_refused');
  try {
    await inviteGuest(ctx, { guestUserId: ticket.authorId, orgId: ticket.orgId });
  } catch (error) {
    // Ошибки модуля пользователей страница показывает кодами модуля обращений.
    if (isHduError(error)) throw new HdtError(error.code === 'rate_limited' || error.code === 'forbidden' || error.code === 'not_found' ? error.code : 'invalid_input');
    throw error;
  }
  return { invited: true };
}

async function senderOf(ctx: StaffContext, number: number): Promise<string | null> {
  const ticket = await ticketAuthorTx(ctx.actor, number);
  return ticket ? ((await guestSenders([ticket.authorId])).get(ticket.authorId)?.address ?? null) : null;
}

export async function markNotClient(ctx: StaffContext, numberValue: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const number = parseInput(numberInput, numberValue);
  await closeUnidentifiedTx(ctx.actor, number, 'not_client', async () => null);
}

export async function markSpam(ctx: StaffContext, numberValue: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const number = parseInput(numberInput, numberValue);
  await closeUnidentifiedTx(ctx.actor, number, 'spam', () => senderOf(ctx, number));
}
