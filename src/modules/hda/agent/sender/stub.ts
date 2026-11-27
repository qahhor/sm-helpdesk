import type { AgentEventSendInput, AgentEventSender, AgentEventSendResult } from './types';

// Заглушка приёмника событий для тестов и разработки без сети: запоминает отправленное, по флагу fail отвечает сбоем.

export class StubAgentEventSender implements AgentEventSender {
  readonly sent: AgentEventSendInput[] = [];
  fail = false;

  async send(input: AgentEventSendInput): Promise<AgentEventSendResult> {
    this.sent.push(input);
    return this.fail ? { ok: false, status: 503 } : { ok: true, status: 202 };
  }
}
