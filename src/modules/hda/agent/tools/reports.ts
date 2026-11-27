import 'server-only';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import * as z from 'zod';
import { readAllowedDomains } from '@/modules/hdk/api/publish';
import { HdaAgentError } from '../../error';
import { AGENT_BODY_MAX, AGENT_TITLE_MAX, REPORT_CHAT_KEYS, REPORT_CHAT_TICKETS_MAX, REPORT_KINDS } from '../../pref';
import { agentReports } from '../../schema';
import { defineTool } from '../tool';
import { AGENT_NOTICE, cleanAgentText, moment, notice, UNTRUSTED_HINT } from '../util';
import { agentTicketsView } from '../views';

// Инструмент create_report (веха M8b, задачи 6 и 10; FR-AGT-04, 13; план M8b, решения 23, 24): сводка в раздел
// "Сводки", непроверенная до отметки сотрудника. Для сообщения в чат команды сводка несёт только числа по
// фиксированным ключам и номера обращений: сообщение собирает портал по своему шаблону, текст агента в чат не попадает.
// Номера обращений вне видимости агента отбрасываются. Токену запуска инструмента не дано.

const count = z.number().int().min(0).max(1_000_000);
const chat = z.strictObject({
  numbers: z.strictObject(Object.fromEntries(REPORT_CHAT_KEYS.map((key) => [key, count.optional()])) as Record<(typeof REPORT_CHAT_KEYS)[number], z.ZodOptional<typeof count>>),
  ticket_numbers: z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).max(REPORT_CHAT_TICKETS_MAX).default([]),
});

export const createReport = defineTool({
  name: 'create_report',
  kind: 'write',
  description: `Save a digest to the "Digests" section for staff (kinds: ${REPORT_KINDS.join(', ')}), marked unverified until a staff member reviews it. Optional "chat" carries only numbers (${REPORT_CHAT_KEYS.join(', ')}) and up to ${REPORT_CHAT_TICKETS_MAX} ticket numbers: the portal builds the team chat message from them with its own template; your text never goes to the chat. ${UNTRUSTED_HINT}`,
  input: z.strictObject({
    kind: z.enum(REPORT_KINDS),
    title: z.string().min(1).max(AGENT_TITLE_MAX),
    body: z.string().min(1).max(AGENT_BODY_MAX),
    period_from: moment.optional(),
    period_to: moment.optional(),
    chat: chat.optional(),
  }),
  output: z.strictObject({ notice, report: z.strictObject({ id: z.uuid() }) }),
  // Адреса для ссылок читает система до транзакции агента (находка I3).
  prepare: () => readAllowedDomains(),
  async run(tx, actor, args, domains) {
    if (args.period_from && args.period_to && args.period_from > args.period_to) throw new HdaAgentError('invalid_arguments');
    const title = cleanAgentText(args.title, domains).slice(0, AGENT_TITLE_MAX);
    const body = cleanAgentText(args.body, domains);
    if (!title || !body) throw new HdaAgentError('invalid_arguments');
    let chatFields: Record<string, unknown> | null = null;
    if (args.chat) {
      const wanted = [...new Set(args.chat.ticket_numbers)];
      const visible = wanted.length
        ? (await tx.select({ number: agentTicketsView.number }).from(agentTicketsView).where(inArray(agentTicketsView.number, wanted))).map((row) => row.number)
        : [];
      const numbers = Object.fromEntries(Object.entries(args.chat.numbers).filter(([, value]) => value !== undefined));
      chatFields = { numbers, ticket_numbers: wanted.filter((n) => visible.includes(n)) };
    }
    const reportId = randomUUID();
    await tx.insert(agentReports).values({
      reportId,
      kind: args.kind,
      title,
      body,
      periodFrom: args.period_from ? new Date(args.period_from) : null,
      periodTo: args.period_to ? new Date(args.period_to) : null,
      chatFields,
      tokenId: actor.tokenId,
    });
    return { result: { notice: AGENT_NOTICE, report: { id: reportId } }, objectRefs: [{ kind: 'report' as const, ref: reportId }] };
  },
});

export const reportTools = [createReport];
