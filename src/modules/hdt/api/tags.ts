import 'server-only';
import * as z from 'zod';
import { isHdrError, parseTagName } from '@/modules/hdr/api';
import type { StaffContext } from '@/modules/hdu/api';
import { assertCanWrite } from '../core/agent-actions';
import { addTagTx, removeTagTx, tagUsageTx } from '../core/tags';
import { HdtError } from '../error';
import { numberInput, parseInput } from '../input';
import { noProtoKeys } from '@/lib/no-proto';

// Модуль hdt, слой api: теги на обращении (FR-AUTO-13; план M8, задача 1, решение 8). Сотрудник из проверенной
// сессии, вход по схеме; ставят и снимают роли, которые ведут обращения (product только читает).

const addInput = z.object({ number: numberInput, name: noProtoKeys(z.unknown()) });
const removeInput = z.object({ number: numberInput, tagId: z.uuid() });

/** Поставить тег по названию. Тега с таким названием ещё нет: он создаётся тем же действием. */
export async function addTicketTag(ctx: StaffContext, input: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(addInput, input);
  let name: string;
  try {
    name = parseTagName(data.name);
  } catch (error) {
    if (isHdrError(error)) throw new HdtError('invalid_input');
    throw error;
  }
  await addTagTx(ctx.actor, data.number, name);
}

/** Снять тег с обращения. */
export async function removeTicketTag(ctx: StaffContext, input: unknown): Promise<void> {
  assertCanWrite(ctx.actor);
  const data = parseInput(removeInput, input);
  await removeTagTx(ctx.actor, data.number, data.tagId);
}

/** На скольких обращениях стоит каждый тег: экран настроек администратора. */
export async function tagUsage(ctx: StaffContext): Promise<Map<string, number>> {
  if (ctx.actor.staffRole !== 'admin') throw new HdtError('forbidden');
  return tagUsageTx(ctx.actor);
}
