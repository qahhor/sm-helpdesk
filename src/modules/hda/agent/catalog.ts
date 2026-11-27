import * as z from 'zod';
import { AGENT_TOOLS, type AgentTool } from '../pref';
import type { McpToolListing } from './server';
import type { AgentToolDef } from './tool';
import { draftTools } from './tools/drafts';
import { ideaTools } from './tools/ideas';
import { metricsTools } from './tools/metrics';
import { noteTools } from './tools/notes';
import { problemTools } from './tools/problems';
import { reportTools } from './tools/reports';
import { solutionTools } from './tools/solutions';
import { ticketTools } from './tools/tickets';

// Каталог инструментов сервера MCP (веха M8b, задачи 4-6; FR-AGT-03, 04, 05; план M8b, решения 9, 13, 17, 18).
// Инструмента, который что-либо показывает клиенту или меняет состояние обращения, в каталоге нет и быть не может
// (CLAUDE.md, FR-AGT-05): имена каталога закрыты перечнем AGENT_TOOLS и проверкой базы hda_agent_tokens_c3.
// Вход и выход каждого инструмента: строгие схемы Zod с пределами длин; описание JSON Schema строится из них же.

export const AGENT_TOOL_DEFS: Partial<Record<AgentTool, AgentToolDef>> = Object.fromEntries(
  [...ticketTools, ...solutionTools, ...problemTools, ...ideaTools, ...metricsTools, ...noteTools, ...draftTools, ...reportTools].map((def) => [def.name, def]),
);

/** Инструменты каталога, у которых есть выполнение, в порядке перечня AGENT_TOOLS. */
export function definedAgentTools(): AgentTool[] {
  return AGENT_TOOLS.filter((name) => AGENT_TOOL_DEFS[name] !== undefined);
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Record<string, unknown>;
  // Ссылка на диалект не нужна: MCP с ревизии 2025-11-25 по умолчанию читает draft 2020-12.
  delete json.$schema;
  return json;
}

const listingCache = new Map<AgentTool, McpToolListing>();

/** Описание инструментов для tools/list: только из перечня токена, в порядке каталога. */
export function agentToolListing(tools: readonly AgentTool[]): McpToolListing[] {
  const allowed = new Set(tools);
  return definedAgentTools()
    .filter((name) => allowed.has(name))
    .map((name) => {
      const cached = listingCache.get(name);
      if (cached) return cached;
      const def = AGENT_TOOL_DEFS[name]!;
      const listing: McpToolListing = { name, description: def.description, inputSchema: jsonSchema(def.input, 'input'), outputSchema: jsonSchema(def.output, 'output') };
      listingCache.set(name, listing);
      return listing;
    });
}

export type { AgentToolDef, ObjectRefs } from './tool';
