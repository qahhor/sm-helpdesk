import { describe, expect, test } from 'vitest';
import { AGENT_TOOL_DEFS, agentToolListing, definedAgentTools } from '@/modules/hda/agent/catalog';
import { AGENT_READ_TOOLS, AGENT_TOOLS, AGENT_WRITE_TOOLS } from '@/modules/hda/pref';

// Каталог инструментов сервера MCP (веха M8b, задача 4; FR-AGT-03, 04, 05; план M8b, решения 9, 13, 17, 18).
// Схемы входа и выхода строгие: лишнее поле отклоняется, длины строк и списков ограничены. В каталоге нет действий,
// которые что-либо показывают клиенту или меняют состояние обращения (CLAUDE.md, FR-AGT-05).

/** Действия, которых у сервера MCP быть не может (FR-AGT-05): ни целым именем, ни частью имени инструмента. */
const FORBIDDEN_AGENT_ACTIONS = [
  'reply', // ответ клиенту
  'send', // отправка и рассылка
  'status', // смена статуса
  'priority',
  'assign', // исполнитель
  'queue',
  'visibility',
  'tag',
  'link', // привязка к проблеме
  'broadcast',
  'mailing',
  'delete',
  'remove',
  'user',
  'org',
  'attachment',
  'file',
  'contact',
  'export',
  'publish',
  'close',
  'merge',
  'escalate',
  'transfer',
] as const;

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; additionalProperties?: unknown; maxLength?: number; maxItems?: number; anyOf?: Schema[]; enum?: unknown[]; const?: unknown; format?: string; pattern?: string };

/** Все места схемы, где объект без запрета лишних полей, строка без предела длины или список без предела. */
function looseSpots(schema: Schema, path = '$'): string[] {
  const out: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes('object') && schema.additionalProperties !== false) out.push(`${path}: объект без additionalProperties: false`);
  if (types.includes('string') && schema.maxLength === undefined && !schema.enum && schema.const === undefined && !schema.format && !schema.pattern)
    out.push(`${path}: строка без предела длины`);
  if (types.includes('array') && schema.maxItems === undefined) out.push(`${path}: список без предела`);
  for (const [key, value] of Object.entries(schema.properties ?? {})) out.push(...looseSpots(value, `${path}.${key}`));
  if (schema.items) out.push(...looseSpots(schema.items, `${path}[]`));
  for (const [i, value] of (schema.anyOf ?? []).entries()) out.push(...looseSpots(value, `${path}|${i}`));
  return out;
}

const listing = agentToolListing([...AGENT_TOOLS]);

describe('каталог инструментов', () => {
  test('имена каталога только из перечня pref и без запрещённых действий FR-AGT-05', () => {
    for (const name of definedAgentTools()) {
      expect(AGENT_TOOLS, name).toContain(name);
      for (const word of FORBIDDEN_AGENT_ACTIONS) expect(name.includes(word), `${name} содержит ${word}`).toBe(false);
    }
    for (const name of AGENT_TOOLS) for (const word of FORBIDDEN_AGENT_ACTIONS) expect(name.includes(word), `${name} содержит ${word}`).toBe(false);
  });

  test('у каждого имени перечня AGENT_TOOLS есть определение (каталог полон после задачи 8)', () => {
    expect(definedAgentTools()).toEqual([...AGENT_TOOLS]);
  });

  test('вид инструмента совпадает с группой чтения или записи', () => {
    for (const name of definedAgentTools()) {
      const def = AGENT_TOOL_DEFS[name]!;
      expect(def.name).toBe(name);
      expect(def.kind, name).toBe((AGENT_READ_TOOLS as readonly string[]).includes(name) ? 'read' : 'write');
      if (def.kind === 'write') expect(AGENT_WRITE_TOOLS as readonly string[]).toContain(name);
    }
  });

  test('схемы входа и выхода строгие, строки и списки ограничены', () => {
    expect(listing.length).toBe(definedAgentTools().length);
    for (const tool of listing) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(looseSpots(tool.inputSchema as Schema), `${tool.name} вход`).toEqual([]);
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(looseSpots(tool.outputSchema as Schema), `${tool.name} выход`).toEqual([]);
    }
  });

  test('лишний аргумент отклоняется схемой входа', () => {
    for (const name of definedAgentTools()) expect(AGENT_TOOL_DEFS[name]!.input.safeParse({ unexpected_field: 1 }).success, name).toBe(false);
  });

  test('выход каждого инструмента несёт постоянное поле notice, описание говорит о полях untrusted_*', () => {
    for (const tool of listing) {
      expect((tool.outputSchema as Schema).properties?.notice, tool.name).toBeDefined();
      expect(tool.description, tool.name).toMatch(/untrusted_/);
    }
  });

  // Проверка на AI-инъекции (волна 7, S-M2; решение 0152): свободная строка из базы лежит только под ключом
  // untrusted_*. Вне его допустимы значения закрытых перечней и идентификаторы строгого вида; их имена перечислены
  // здесь с причиной, новое поле со свободной строкой вне untrusted_* роняет тест.
  const TRUSTED_STRING_FIELDS: Record<string, string> = {
    notice: 'постоянный текст портала',
    // Закрытые перечни (проверка CHECK в базе или перечень в коде).
    status: 'перечень',
    priority: 'перечень',
    queue: 'перечень',
    type: 'перечень',
    impact: 'перечень',
    locale: 'перечень языков',
    source: 'перечень',
    audience: 'перечень',
    ai_state: 'перечень',
    ai_handoff_reason: 'перечень',
    ai_kind: 'перечень',
    resolution_type: 'перечень',
    from_line: 'перечень',
    to_line: 'перечень',
    reason_code: 'перечень',
    reason: 'перечень причин передачи',
    rule: 'перечень правил отклонения отчёта',
    // Идентификаторы строгого вида, которые строит портал или проверяет схема при записи.
    author: 'обозначение "client:1", "staff:2" строит портал',
    signature: 'хеш из 32 шестнадцатеричных знаков',
    signatures: 'хеши',
    module: 'код модуля из справочника, который ведёт администратор (решение 0152)',
    modules: 'коды модулей',
    code: 'код ошибки каталога: вид [A-Z]{2,5}-цифры проверен схемой отчёта при записи',
    scan_key: 'ключ сканирования строгого вида, прислан самим агентом',
    path: 'путь поля отчёта, присланного самим агентом',
  };

  function freeStrings(schema: Schema, path: string, name: string, under: boolean, out: string[]) {
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.includes('string') && !schema.enum && schema.const === undefined && !schema.format && !schema.pattern && !under && !(name in TRUSTED_STRING_FIELDS)) out.push(path);
    for (const [key, value] of Object.entries(schema.properties ?? {})) freeStrings(value, `${path}.${key}`, key, under || key.startsWith('untrusted_'), out);
    if (schema.items) freeStrings(schema.items, `${path}[]`, name, under, out);
    for (const option of schema.anyOf ?? []) freeStrings(option, path, name, under, out);
  }

  test('каждая свободная строка в ответе любого инструмента лежит под ключом untrusted_*', () => {
    const out: string[] = [];
    for (const tool of listing) freeStrings(tool.outputSchema as Schema, tool.name, '', false, out);
    expect(out).toEqual([]);
  });

  test('search_code_catalog: ключ, место в коде и шаблоны только под untrusted_*', () => {
    const entry = ((listing.find((tool) => tool.name === 'search_code_catalog')!.outputSchema as Schema).properties!.entries!.items as Schema).properties!;
    expect(Object.keys(entry)).toEqual(expect.arrayContaining(['untrusted_key', 'untrusted_raised_in', 'untrusted_templates']));
    for (const key of ['key', 'raised_in', 'templates']) expect(Object.keys(entry)).not.toContain(key);
  });

  test('перечень токена ограничивает листинг: чужих инструментов нет', () => {
    const defined = definedAgentTools();
    const one = defined[0]!;
    expect(agentToolListing([one]).map((tool) => tool.name)).toEqual([one]);
    expect(agentToolListing([]).map((tool) => tool.name)).toEqual([]);
  });
});
