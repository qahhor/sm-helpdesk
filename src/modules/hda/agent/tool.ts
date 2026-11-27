import type * as z from 'zod';
import type { Tx } from '@/db/client';
import type { AgentActor } from '@/db/with-actor';
import type { AgentTool } from '../pref';
import type { AgentObjectRef } from '../schema';

// Вид инструмента сервера MCP (веха M8b, задача 4). Отдельный файл: каталог собирает инструменты из tools/*.ts, а те
// определяются через defineTool без круговой зависимости.

export type ObjectRefs = AgentObjectRef[];

/** Инструмент: схемы входа и выхода, выполнение в транзакции актора agent. */
export type AgentToolDef<I = unknown, O = unknown> = {
  name: AgentTool;
  kind: 'read' | 'write';
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run(tx: Tx, actor: AgentActor, input: I): Promise<{ result: O; objectRefs: ObjectRefs }>;
};

/** Определение инструмента с выводом типов входа и выхода из схем. */
export function defineTool<I, O>(def: AgentToolDef<I, O>): AgentToolDef {
  return def as unknown as AgentToolDef;
}

