import type * as z from 'zod';
import type { Tx } from '@/db/client';
import type { AgentActor } from '@/db/with-actor';
import type { AgentTool } from '../pref';
import type { AgentObjectRef } from '../schema';

// Вид инструмента сервера MCP (веха M8b, задача 4). Отдельный файл: каталог собирает инструменты из tools/*.ts, а те
// определяются через defineTool без круговой зависимости.
//
// Транзакция актора agent держит одно соединение пула, и внутри неё не открывается ни одной другой (независимая
// проверка M8b, находка I3): то, что читает система (адреса для ссылок, показатели), инструмент получает из prepare до
// транзакции, а слова обезличивания система читает после неё: инструмент возвращает отложенный ответ, который
// собирает finish с готовым обезличиванием.

export type ObjectRefs = AgentObjectRef[];

/** Обезличивание текста: слова организации orgId (или всех организаций ответа, 'all') и сотрудников. */
export type Redactor = (orgId: string | null | 'all', text: string) => string;

/** Что нужно обезличиванию ответа: организации, обращения (их люди), проблемы и кандидаты (их организации). */
export type RedactScope = {
  orgIds?: readonly string[];
  ticketIds?: readonly string[];
  problemIds?: readonly string[];
  candidateIds?: readonly string[];
};

export type ToolOutcome<O> = { result: O; objectRefs: ObjectRefs };
/** Ответ, который собирается после транзакции агента, когда система прочитала слова обезличивания. */
export type DeferredOutcome<O> = { redact: RedactScope; finish(redact: Redactor): ToolOutcome<O> };

export function isDeferred<O>(value: ToolOutcome<O> | DeferredOutcome<O>): value is DeferredOutcome<O> {
  return 'finish' in value;
}

/** Инструмент: схемы входа и выхода, подготовка системой до транзакции, выполнение в транзакции актора agent. */
export type AgentToolDef<I = unknown, O = unknown, P = unknown> = {
  name: AgentTool;
  kind: 'read' | 'write';
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  prepare?(input: I): Promise<P>;
  run(tx: Tx, actor: AgentActor, input: I, prepared: P): Promise<ToolOutcome<O> | DeferredOutcome<O>>;
};

/** Определение инструмента с выводом типов входа и выхода из схем. */
export function defineTool<I, O, P = undefined>(def: AgentToolDef<I, O, P>): AgentToolDef {
  return def as unknown as AgentToolDef;
}
