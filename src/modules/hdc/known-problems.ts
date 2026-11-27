import 'server-only';
import { logEvent } from '@/lib/log';

// Модуль hdc: привязка нового обращения к известной проблеме по сигнатуре (ТЗ FR-KP-04; план M5c, задача 3, решение 8).
// Обращения создаёт модуль hdt, проблемы ведёт модуль hdp, который сам стоит над hdt. Чтобы hdt не зависел от hdp,
// интерфейс объявлен здесь, реализацию даёт hdp, подключает её src/wiring.ts (как запись сигнатуры, решение 0039).
// Привязка идёт сразу после записи сигнатуры обращения (recordTicketSignature) во всех каналах создания и до помощника.

export interface KnownProblemLinker {
  /** Привязать обращение к активной проблеме с этой сигнатурой. Нет проблемы или привязка не нужна: null. */
  linkBySignature(input: { ticketId: string; orgId: string; signature: string | null }): Promise<{ problemNumber: number } | null>;
  /**
   * Явная привязка "Меня это тоже затронуло" (FR-KP-08) к уже известной проблеме, если по сигнатуре обращение не
   * привязалось. Не привязалось (проблема не активна, обращение уже у другой проблемы): null.
   */
  linkAffected(input: { ticketId: string; problemId: string }): Promise<{ problemNumber: number } | null>;
}

const shared = globalThis as typeof globalThis & { __hubKnownProblems?: KnownProblemLinker };

/** Подключает привязку. Вызывается один раз при запуске процесса из src/wiring.ts. */
export function registerKnownProblemLinker(linker: KnownProblemLinker): void {
  shared.__hubKnownProblems = linker;
}

/**
 * Привязка нового обращения по сигнатуре. Обращение уже создано: сбой привязки его не отменяет и не показывается
 * клиенту, а пишется в журнал работы без текста.
 */
export async function linkKnownProblem(input: { ticketId: string; orgId: string; signature: string | null; knownProblemId?: string }): Promise<{ problemNumber: number } | null> {
  if (!input.signature && !input.knownProblemId) return null;
  const linker = shared.__hubKnownProblems;
  if (!linker) {
    logEvent('error', 'ticket.known_problem_unwired', { ticketId: input.ticketId });
    return null;
  }
  try {
    const bySignature = input.signature ? await linker.linkBySignature({ ticketId: input.ticketId, orgId: input.orgId, signature: input.signature }) : null;
    // Известная проблема задана сервером ("Меня это тоже затронуло"): привязка до помощника, чтобы задача первой
    // линии уже видела её. Привязанное по сигнатуре не трогается.
    if (bySignature || !input.knownProblemId) return bySignature;
    return await linker.linkAffected({ ticketId: input.ticketId, problemId: input.knownProblemId });
  } catch (error) {
    logEvent('error', 'ticket.known_problem_failed', { ticketId: input.ticketId, error: error instanceof Error ? error.name : 'Error' });
    return null;
  }
}
