import { and, arrayContains, desc, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';
import { errorSampleTemplate } from '@/modules/hdk/api/signatures';
import { moduleCodesTx, moduleIdsByCodesTx } from '@/modules/hdr/api';
import { HdaAgentError } from '../../error';
import { PROBLEM_STATUSES } from '@/modules/hdp/pref';
import { defineTool, type Redactor } from '../tool';
import { iso, moment, notice, AGENT_NOTICE, str, UNTRUSTED_HINT } from '../util';
import { agentProblemsView, agentSignaturesView } from '../views';

// Инструмент list_known_problems (веха M8b, задачи 4-5; FR-AGT-03; план M8b, решение 17): известные проблемы с
// внутренним названием, статусом, счётчиками и действующими сигнатурами, без разбивки по организациям. Строки отбирает
// представление hda_agent_problems (без проблем, все привязанные обращения которых из организаций без AI-обработки,
// миграция 0117). Внутреннее название пишут сотрудники: оно обезличивается словами организаций привязанных обращений и
// именами сотрудников (находка I2) и лежит в untrusted_text.

const LIMIT = 50;
const SIGNATURE = /^[0-9a-f]{32}$/;
const ACTIVE = ['investigating', 'cause_found', 'fixing'] as const;

const input = z.strictObject({
  status: z.enum(['active', ...PROBLEM_STATUSES]).optional(),
  signature: z.string().regex(SIGNATURE).optional(),
  limit: z.number().int().min(1).max(LIMIT).default(LIMIT),
});

const item = z.strictObject({
  number: z.number().int(),
  status: str(20),
  module: str(80).nullable(),
  untrusted_text: z.strictObject({ internal_title: str(400) }),
  signatures: z.array(str(64)).max(100),
  ticket_count: z.number().int(),
  org_count: z.number().int(),
  first_seen_on: moment.nullable(),
  last_seen_on: moment.nullable(),
  fixed_on: moment.nullable(),
  shown_to_clients: z.boolean(),
});
const output = z.strictObject({ notice, items: z.array(item).max(LIMIT) });

export const listKnownProblems = defineTool({
  name: 'list_known_problems',
  kind: 'read',
  description: `Known problems: number, status, module code, internal title, active error signatures and counters, no per-organization breakdown. status "active" means investigating, cause_found or fixing. At most ${LIMIT}. ${UNTRUSTED_HINT}`,
  input,
  output,
  async run(tx, _actor, args) {
    const statusFilter = args.status === 'active' ? inArray(agentProblemsView.status, [...ACTIVE]) : args.status ? eq(agentProblemsView.status, args.status) : undefined;
    const rows = await tx
      .select()
      .from(agentProblemsView)
      .where(and(statusFilter, args.signature ? arrayContains(agentProblemsView.signatures, [args.signature]) : undefined))
      .orderBy(desc(agentProblemsView.lastSeenOn), desc(agentProblemsView.number))
      .limit(args.limit);
    const modules = await moduleCodesTx(tx, rows.flatMap((row) => (row.moduleId ? [row.moduleId] : [])));
    // Название обезличивается словами организаций привязанных обращений и сотрудников (находка I2): их читает система.
    return {
      redact: { problemIds: rows.map((row) => row.problemId) },
      finish: (redact: Redactor) => {
    const items = rows.map((row) => ({
      number: row.number,
      status: row.status,
      module: row.moduleId ? (modules.get(row.moduleId) ?? null) : null,
      untrusted_text: { internal_title: redact('all', row.internalTitle).slice(0, 400) },
      signatures: row.signatures.slice(0, 100),
      ticket_count: row.ticketCount,
      org_count: row.orgCount,
      first_seen_on: iso(row.firstSeenOn),
      last_seen_on: iso(row.lastSeenOn),
      fixed_on: iso(row.fixedOn),
      shown_to_clients: row.showToClients,
    }));
    return { result: { notice: AGENT_NOTICE, items }, objectRefs: items.map((p) => ({ kind: 'problem' as const, ref: p.number })) };
      },
    };
  },
});

// --- unsolved_signatures ---

const SIGNATURES_MAX = 50;

export const unsolvedSignatures = defineTool({
  name: 'unsolved_signatures',
  kind: 'read',
  description: `Error signatures without a bound solution, most organizations and occurrences first: signature, module code, error code, anonymized sample message and counters (counted over all organizations, no breakdown). At most ${SIGNATURES_MAX}. ${UNTRUSTED_HINT}`,
  input: z.strictObject({ module: z.string().max(80).optional(), limit: z.number().int().min(1).max(SIGNATURES_MAX).default(SIGNATURES_MAX) }),
  output: z.strictObject({
    notice,
    items: z
      .array(
        z.strictObject({
          signature: str(32),
          module: str(80).nullable(),
          untrusted_sample_code: str(80).nullable(),
          org_count: z.number().int(),
          occurrences: z.number().int(),
          last_seen_on: moment.nullable(),
          untrusted_text: z.strictObject({ sample_message: str(301).nullable() }),
        }),
      )
      .max(SIGNATURES_MAX),
  }),
  async run(tx, _actor, args) {
    const v = agentSignaturesView;
    const moduleId = args.module === undefined ? undefined : ((await moduleIdsByCodesTx(tx, [args.module])).get(args.module) ?? null);
    if (moduleId === null) throw new HdaAgentError('not_found');
    const rows = await tx
      .select()
      .from(v)
      .where(and(eq(v.hasSolution, false), moduleId ? eq(v.moduleId, moduleId) : undefined))
      .orderBy(desc(v.orgCount), desc(v.occurrences), desc(v.signature))
      .limit(args.limit);
    const modules = await moduleCodesTx(tx, rows.flatMap((row) => (row.moduleId ? [row.moduleId] : [])));
    // Образец текста ошибки (волна 7, S-M3; решение 0152): шаблоном (числа, значения в кавычках и идентификаторы
    // заменены) и обезличенным по всем организациям, у которых сигнатура встречалась: слова читает система после
    // транзакции агента. Образец с первой встречи мог сохранить название организации или имя участника.
    return {
      redact: { signatures: rows.map((row) => row.signature) },
      finish: (redact: Redactor) => ({
        result: {
          notice: AGENT_NOTICE,
          items: rows.map((row) => ({
            signature: row.signature,
            module: row.moduleId ? (modules.get(row.moduleId) ?? null) : null,
            untrusted_sample_code: row.sampleCode ? row.sampleCode.slice(0, 80) : null,
            org_count: row.orgCount,
            occurrences: row.occurrences,
            last_seen_on: iso(row.lastSeenOn),
            untrusted_text: { sample_message: row.sampleMessage ? redact('all', errorSampleTemplate(row.sampleMessage)).slice(0, 300) : null },
          })),
        },
        objectRefs: [],
      }),
    };
  },
});

export const problemTools = [listKnownProblems, unsolvedSignatures];
