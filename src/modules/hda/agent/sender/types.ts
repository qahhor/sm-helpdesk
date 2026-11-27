// Приёмник событий AI-сотрудника (веха M8b, задача 9; FR-AGT-08; CLAUDE.md: интерфейс, настоящая реализация и
// заглушка). Тело уже подписано: отправителю нужны только адрес, тело и заголовки.

export type AgentEventSendInput = { url: string; body: string; headers: Record<string, string> };
export type AgentEventSendResult = { ok: boolean; status: number | null };

export interface AgentEventSender {
  send(input: AgentEventSendInput): Promise<AgentEventSendResult>;
}
