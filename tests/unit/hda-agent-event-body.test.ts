import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { agentEventBody, agentEventHeaders } from '@/modules/hda/agent/events';
import { signatureHeader as hdcSignature } from '@/modules/hdc/webhook-sign';
import { signatureHeader as hdwSignature } from '@/modules/hdw/webhook-sign';

// Тело события для AI-сотрудника (веха M8b, задача 9; FR-AGT-08, 10; план M8b, решение 26): только коды и
// идентификаторы. Ни темы, ни текста, ни имён, ни названия организации. Подпись тем же форматом X-Hub-Signature,
// что исходящие вебхуки M8 (функция перенесена в hdc и общая для обоих модулей).

const at = new Date('2026-11-27T10:00:00Z');
const ticket = { id: '019a0000-0000-7000-8000-000000000001', number: 1042, priority: 'p2', queue: 'l1', module: 'orders', orgId: '019a0000-0000-7000-8000-0000000000aa', orgCategory: 'B' as const };
const junk = { title: 'Накладная ACME не проводится', description: 'Звоните +998901234567', orgName: 'ACME Trade', authorName: 'Алишер', email: 'alisher@acme.uz' };

describe('agentEventBody', () => {
  test('событие по обращению: вид, момент, номер, идентификатор, приоритет, очередь, модуль, организация кодом, причина', () => {
    const body = agentEventBody({ eventId: 'e1', kind: 'ai_handoff', occurredOn: at, ticket: { ...ticket, ...junk } as never, reason: 'not_helped', ...junk } as never);
    expect(body).toEqual({
      id: 'e1',
      kind: 'ai_handoff',
      occurred_on: '2026-11-27T10:00:00.000Z',
      ticket: { id: ticket.id, number: 1042, priority: 'p2', queue: 'l1', module: 'orders', org: { id: ticket.orgId, category: 'B' } },
      reason: 'not_helped',
    });
    const text = JSON.stringify(body);
    for (const value of Object.values(junk)) expect(text).not.toContain(value);
  });
  test('передача на вторую линию с причиной кодом, нарушение SLA со сроком', () => {
    expect(agentEventBody({ eventId: 'e2', kind: 'line_transferred', occurredOn: at, ticket, reason: 'suspected_bug' })).toMatchObject({ kind: 'line_transferred', reason: 'suspected_bug' });
    expect(agentEventBody({ eventId: 'e3', kind: 'sla_breached', occurredOn: at, ticket, deadline: 'resolution' })).toMatchObject({ kind: 'sla_breached', deadline: 'resolution' });
    expect(agentEventBody({ eventId: 'e3', kind: 'sla_breached', occurredOn: at, ticket, deadline: 'нестандартный срок' }).deadline).toBeUndefined();
  });
  test('всплеск: сигнатура и числа, без обращений и организаций кроме номеров', () => {
    const body = agentEventBody({ eventId: 'e4', kind: 'signature_spike', occurredOn: at, spike: { signature: 'a'.repeat(32), orgCount: 3, ticketCount: 5, windowMinutes: 60, ticketNumbers: [1, 2] } });
    expect(body).toEqual({ id: 'e4', kind: 'signature_spike', occurred_on: '2026-11-27T10:00:00.000Z', spike: { signature: 'a'.repeat(32), org_count: 3, ticket_count: 5, window_minutes: 60, ticket_numbers: [1, 2] } });
  });
  test('причина вне перечня кодов отбрасывается: текст в событие не проходит', () => {
    expect(agentEventBody({ eventId: 'e5', kind: 'ai_handoff', occurredOn: at, ticket, reason: 'Клиент Алишер просит' }).reason).toBeUndefined();
  });
});

describe('подпись события', () => {
  test('заголовок X-Hub-Signature тем же кодом, что вебхуки M8, проверяется приёмником', () => {
    expect(hdwSignature).toBe(hdcSignature);
    const raw = JSON.stringify({ id: 'e1' });
    const headers = agentEventHeaders({ secret: 's'.repeat(32), rawBody: raw, eventId: 'e1', kind: 'ai_handoff', now: at });
    const t = Math.floor(at.getTime() / 1000);
    expect(headers['X-Hub-Signature']).toBe(`t=${t},v1=${createHmac('sha256', 's'.repeat(32)).update(`${t}.${raw}`).digest('hex')}`);
    expect(headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Hub-Event': 'agent.ai_handoff', 'X-Hub-Delivery': 'e1' });
  });
});
