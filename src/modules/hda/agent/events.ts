import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signatureHeader } from '@/modules/hdc/api';
import { AI_HANDOFF_REASONS, TRANSFER_REASONS } from '@/modules/hdt/pref';

// Тело и заголовки события для AI-сотрудника (веха M8b, задача 9; FR-AGT-08; план M8b, решение 26). Чистые функции.
// В теле только коды и идентификаторы: вид, момент, номер и идентификатор обращения, организация идентификатором и
// категорией, приоритет, очередь, модуль, причина кодом из перечня, у всплеска сигнатура и числа. Тему, текст, имена и
// названия функция не берёт, даже если их передали: строит тело по белому списку полей.

export const AGENT_EVENT_KINDS = ['ai_handoff', 'line_transferred', 'sla_breached', 'signature_spike', 'code_analysis_requested'] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export type AgentEventTicket = { id: string; number: number; priority: string; queue: string | null; module: string | null; orgId: string; orgCategory: 'A' | 'B' | 'C' | 'D' | null };
export type AgentEventSource =
  | { eventId: string; kind: 'ai_handoff' | 'line_transferred' | 'sla_breached'; occurredOn: Date; ticket: AgentEventTicket; reason?: string | null; deadline?: string | null }
  | { eventId: string; kind: 'code_analysis_requested'; occurredOn: Date; ticket: AgentEventTicket; analysisRequestId: string }
  | { eventId: string; kind: 'signature_spike'; occurredOn: Date; spike: { signature: string; orgCount: number; ticketCount: number; windowMinutes: number; ticketNumbers: readonly number[] } };

export type AgentEventBody = {
  id: string;
  kind: AgentEventKind;
  occurred_on: string;
  ticket?: { id: string; number: number; priority: string; queue: string | null; module: string | null; org: { id: string; category: 'A' | 'B' | 'C' | 'D' | null } };
  reason?: string;
  deadline?: string;
  spike?: { signature: string; org_count: number; ticket_count: number; window_minutes: number; ticket_numbers: number[] };
  /** Запрос анализа по коду (веха M8c): ответ агент отдаёт инструментом submit_code_analysis. */
  analysis_request?: { id: string };
};

const REASONS: ReadonlySet<string> = new Set<string>([...AI_HANDOFF_REASONS, ...TRANSFER_REASONS]);
const DEADLINES: ReadonlySet<string> = new Set(['first_response', 'resolution']);
const CODE = /^[a-z0-9_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function agentEventBody(source: AgentEventSource): AgentEventBody {
  const base = { id: String(source.eventId), kind: source.kind, occurred_on: source.occurredOn.toISOString() };
  if (source.kind === 'signature_spike') {
    const s = source.spike;
    return {
      ...base,
      spike: { signature: String(s.signature), org_count: Number(s.orgCount), ticket_count: Number(s.ticketCount), window_minutes: Number(s.windowMinutes), ticket_numbers: s.ticketNumbers.slice(0, 50).map(Number) },
    };
  }
  const t = source.ticket;
  const code = (value: unknown) => (typeof value === 'string' && CODE.test(value) ? value : null);
  return {
    ...base,
    ticket: { id: String(t.id), number: Number(t.number), priority: code(t.priority) ?? '', queue: code(t.queue), module: typeof t.module === 'string' ? t.module.slice(0, 80) : null, org: { id: String(t.orgId), category: t.orgCategory ?? null } },
    ...(source.kind === 'code_analysis_requested'
      ? UUID.test(String(source.analysisRequestId))
        ? { analysis_request: { id: String(source.analysisRequestId) } }
        : {}
      : {
          ...(typeof source.reason === 'string' && REASONS.has(source.reason) ? { reason: source.reason } : {}),
          ...(typeof source.deadline === 'string' && DEADLINES.has(source.deadline) ? { deadline: source.deadline } : {}),
        }),
  };
}

/** Заголовки события: подпись X-Hub-Signature тем же форматом, что вебхуки M8, вид и идентификатор доставки. */
export function agentEventHeaders(input: { secret: string; rawBody: string; eventId: string; kind: AgentEventKind; now: Date }): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [SIGNATURE_HEADER]: signatureHeader(input.secret, Math.floor(input.now.getTime() / 1000), input.rawBody),
    [EVENT_HEADER]: `agent.${input.kind}`,
    [DELIVERY_HEADER]: input.eventId,
    'user-agent': 'SmartupHub-Agent/1',
  };
}
