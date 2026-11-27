import 'server-only';
import { desc, gte } from 'drizzle-orm';
import * as z from 'zod';
import { defineTool } from '../tool';
import { AGENT_NOTICE, moment, notice, str } from '../util';
import { agentSpikesView } from '../views';

// Инструмент signature_spikes (веха M8b, задача 8; FR-AGT-03, 11; план M8b, решение 25): всплески сигнатур за период,
// числа и номера обращений окна, видимых агенту. Организаций нет. Только числа и коды: полей untrusted_* в ответе нет.

const LIMIT = 50;

export const signatureSpikesTool = defineTool({
  name: 'signature_spikes',
  kind: 'read',
  description: `Error signature spikes detected by the portal over the last N days (1-30, default 7): signature, number of organizations and tickets in the window, window minutes, known problem number if created, and up to 50 ticket numbers visible to you. Newest first, at most ${LIMIT}. Numbers and codes only, no untrusted_* fields.`,
  input: z.strictObject({ days: z.number().int().min(1).max(30).default(7), limit: z.number().int().min(1).max(LIMIT).default(LIMIT) }),
  output: z.strictObject({
    notice,
    items: z
      .array(
        z.strictObject({
          signature: str(32),
          org_count: z.number().int(),
          ticket_count: z.number().int(),
          window_minutes: z.number().int(),
          detected_on: moment,
          problem_number: z.number().int().nullable(),
          ticket_numbers: z.array(z.number().int()).max(50),
        }),
      )
      .max(LIMIT),
  }),
  async run(tx, _actor, args) {
    const v = agentSpikesView;
    const rows = await tx
      .select()
      .from(v)
      .where(gte(v.detectedOn, new Date(Date.now() - args.days * 86_400_000)))
      .orderBy(desc(v.detectedOn))
      .limit(args.limit);
    const items = rows.map((row) => ({
      signature: row.signature,
      org_count: row.orgCount,
      ticket_count: row.ticketCount,
      window_minutes: row.windowMinutes,
      detected_on: row.detectedOn.toISOString(),
      problem_number: row.problemNumber,
      ticket_numbers: row.ticketNumbers.slice(0, 50),
    }));
    return { result: { notice: AGENT_NOTICE, items }, objectRefs: items.flatMap((item) => item.ticket_numbers.map((n) => ({ kind: 'ticket' as const, ref: n }))) };
  },
});

export const spikeTools = [signatureSpikesTool];
