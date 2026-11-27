// Модуль hda, слой error: ошибки модуля (docs/naming.md, раздел 5; правило ошибок: решение 0022).

export const HDA_ERROR_CODES = ['forbidden', 'invalid_input', 'stale_session', 'not_found', 'ai_disabled', 'conflict'] as const;
export type HdaErrorCode = (typeof HDA_ERROR_CODES)[number];

export class HdaError extends Error {
  readonly code: HdaErrorCode;

  constructor(code: HdaErrorCode) {
    super(`hda: ${code}`);
    this.name = 'HdaError';
    this.code = code;
  }
}

export function isHdaError(error: unknown): error is HdaError {
  return error instanceof HdaError;
}

/**
 * Ошибки инструментов сервера MCP (веха M8b, решение 30). Отдаются агенту результатом инструмента с isError и кодом,
 * без текста исключений, стеков и запросов. Объект вне видимости агента отвечает not_found, как будто его нет.
 */
export const HDA_AGENT_ERROR_CODES = ['tool_not_allowed', 'invalid_arguments', 'rate_limited', 'not_found', 'note_limit', 'internal'] as const;
export type HdaAgentErrorCode = (typeof HDA_AGENT_ERROR_CODES)[number];

export class HdaAgentError extends Error {
  readonly code: HdaAgentErrorCode;
  /** Через сколько секунд повторить: только у rate_limited. */
  readonly retryAfterSec: number | null;

  constructor(code: HdaAgentErrorCode, retryAfterSec: number | null = null) {
    super(`hda agent: ${code}`);
    this.name = 'HdaAgentError';
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export function isHdaAgentError(error: unknown): error is HdaAgentError {
  return error instanceof HdaAgentError;
}
