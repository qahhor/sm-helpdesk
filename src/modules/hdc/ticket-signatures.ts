import 'server-only';
import { logEvent } from '@/lib/log';

// Модуль hdc: сигнатура ошибки нового обращения (план M5, задача 8, решения 7 и 8). Обращения создаёт модуль hdt,
// а сигнатуры и организации сигнатур ведёт модуль знаний hdk, который сам стоит над hdt (берёт у него переписку
// и ключ поиска). Чтобы hdt не зависел от hdk, интерфейс объявлен здесь, реализацию даёт hdk, подключает её файл
// src/wiring.ts при запуске процесса (как справочник контактов, решение 0039).
//
// Сигнатуру считает только сервер: клиент её не передаёт и не может задать (триггер t_hdt_tickets_client_guard
// не пускает error_signature во вставку клиента), иначе клиент накручивал бы число организаций любой сигнатуры.

export type TicketSignatureInput = {
  ticketId: string;
  orgId: string;
  authorId: string | null;
  description: string;
  /** Код и текст ошибки из контекста виджета (M6). На портале пусто: строка ошибки ищется в описании. */
  context: { errorCode?: string; errorText?: string } | null;
  moduleId: string | null;
};

export interface TicketSignatureRecorder {
  /** Сигнатура обращения: пишет её в обращение, сигнатуру и организацию сигнатуры от имени системы. Нет ошибки: null. */
  recordTicket(input: TicketSignatureInput): Promise<string | null>;
}

const shared = globalThis as typeof globalThis & { __hubTicketSignatures?: TicketSignatureRecorder };

/** Подключает запись сигнатур. Вызывается один раз при запуске процесса из src/wiring.ts. */
export function registerTicketSignatureRecorder(recorder: TicketSignatureRecorder): void {
  shared.__hubTicketSignatures = recorder;
}

/**
 * Сигнатура нового обращения после фиксации обращения. Обращение уже создано: сбой сигнатуры его не отменяет и
 * не показывается клиенту, а пишется в журнал работы без текста (подсказка по сигнатуре просто не сработает).
 */
export async function recordTicketSignature(input: TicketSignatureInput): Promise<string | null> {
  const recorder = shared.__hubTicketSignatures;
  if (!recorder) {
    logEvent('error', 'ticket.signature_unwired', { ticketId: input.ticketId });
    return null;
  }
  try {
    return await recorder.recordTicket(input);
  } catch (error) {
    logEvent('error', 'ticket.signature_failed', { ticketId: input.ticketId, error: error instanceof Error ? error.name : 'Error' });
    return null;
  }
}
