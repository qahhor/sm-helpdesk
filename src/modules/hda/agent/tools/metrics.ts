import 'server-only';
import * as z from 'zod';
import { assistantMetricsForAgent } from '@/modules/hdt/api/metrics';
import { HdaAgentError } from '../../error';
import { defineTool } from '../tool';
import { AGENT_NOTICE, moment, notice, str } from '../util';

// Инструмент assistant_metrics (веха M8b, задача 5; FR-AGT-03; план M8b, решение 17): показатели помощника за период,
// только числа, те же, что на /agent/metrics. Агрегаты считает система функцией модуля обращений: текстов, имён и
// разбивки по организациям в ответе нет.

const SYSTEM = { type: 'system', job: 'mcp.assistant_metrics' } as const;
const day = z.iso.date();

export const assistantMetrics = defineTool({
  name: 'assistant_metrics',
  kind: 'read',
  description:
    'Assistant (first line AI) metrics for a period of days (from, to inclusive, up to the metrics screen limit): tickets handled, resolved by AI, handoffs by reason, first reply count and median, CSAT, reopened after "helped". Numbers only; no untrusted_* fields.',
  input: z.strictObject({ from: day, to: day }),
  output: z.strictObject({
    notice,
    period: z.strictObject({ from: moment, to: moment }),
    metrics: z.strictObject({
      handled: z.number().int(),
      resolved_by_ai: z.number().int(),
      handoffs: z.array(z.strictObject({ reason: str(40), count: z.number().int() })).max(50),
      first_reply_count: z.number().int(),
      first_reply_median_sec: z.number().nullable(),
      csat_count: z.number().int(),
      csat_average: z.number().nullable(),
      reopened_after_helped: z.number().int(),
    }),
  }),
  // Показатели считает система до транзакции агента (находка I3): вызов не держит два соединения.
  prepare: (args) =>
    assistantMetricsForAgent(SYSTEM, args).catch(() => {
      throw new HdaAgentError('invalid_arguments');
    }),
  async run(_tx, _actor, _args, stats) {
    return {
      result: {
        notice: AGENT_NOTICE,
        period: { from: stats.period.from.toISOString(), to: stats.period.to.toISOString() },
        metrics: {
          handled: stats.handled,
          resolved_by_ai: stats.resolvedByAi,
          handoffs: stats.handoffs.slice(0, 50).map((h) => ({ reason: h.reason.slice(0, 40), count: h.count })),
          first_reply_count: stats.firstReply.count,
          first_reply_median_sec: stats.firstReply.medianSeconds,
          csat_count: stats.csat.count,
          csat_average: stats.csat.average,
          reopened_after_helped: stats.reopenedAfterHelped,
        },
      },
      objectRefs: [],
    };
  },
});

export const metricsTools = [assistantMetrics];
