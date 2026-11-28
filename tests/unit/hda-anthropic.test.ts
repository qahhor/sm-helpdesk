import { expect, test } from 'vitest';
import * as z from 'zod';
import { AiResponseError, AiUnavailableError } from '@/modules/hda/client/types';
import { ANTHROPIC_URL, ANTHROPIC_VERSION, createAnthropicClient } from '@/modules/hda/testing';
import { BlockedAddressError, type GuardedPost, OutboundTimeoutError } from '@/security/outbound';

// Тонкий клиент Anthropic Messages API (план M5, задача 5, решение 4). Настоящий API не вызывался: тест подменяет
// запрос и проверяет его точный вид (адрес, заголовки, модель из окружения, тело) и разбор ответа схемой.

const schema = z.object({ title: z.string(), confident: z.boolean() });
type Sent = { cfg: Parameters<GuardedPost>[0]; url: string; opts: Parameters<GuardedPost>[2] };

function client(reply: { status: number; body?: string } | Error) {
  const sent: Sent[] = [];
  const post: GuardedPost = async (cfg, url, opts) => {
    sent.push({ cfg, url: String(url), opts });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { sent, ai: createAnthropicClient({ apiKey: 'sk-ant-test-key-000', post }) };
}

const message = (text: string, extra: object = {}) =>
  JSON.stringify({
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'model-fast-id-20261101',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 34 },
    ...extra,
  });

test('запрос: адрес api.anthropic.com/v1/messages, ключ и версия в заголовках, модель из запроса, без инструментов', async () => {
  const { sent, ai } = client({ status: 200, body: message('{"title":"Т","confident":true}') });
  const result = await ai.complete({ model: 'model-fast-id', system: 'ПРАВИЛА', data: '<ticket>данные</ticket>', schema, maxTokens: 1500 });
  expect(sent).toHaveLength(1);
  const [call] = sent;
  expect(call!.url).toBe('https://api.anthropic.com/v1/messages');
  expect(ANTHROPIC_URL).toBe('https://api.anthropic.com/v1/messages');
  // Внутренние адреса и http не допускаются: запрос идёт только наружу.
  expect(call!.cfg).toEqual({ allowLoopback: false });
  expect(call!.opts.headers).toEqual({ 'x-api-key': 'sk-ant-test-key-000', 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' });
  expect(ANTHROPIC_VERSION).toBe('2023-06-01');
  expect(call!.opts.readBody).toBe(true);
  expect(call!.opts.timeoutMs).toBe(60_000);
  expect(JSON.parse(call!.opts.body)).toEqual({
    model: 'model-fast-id',
    max_tokens: 1500,
    system: 'ПРАВИЛА',
    messages: [{ role: 'user', content: '<ticket>данные</ticket>' }],
  });
  expect(result).toEqual({ value: { title: 'Т', confident: true }, model: 'model-fast-id-20261101', usage: { inputTokens: 120, outputTokens: 34 } });
});

test('модель берётся из запроса; JSON в ограждении кода разбирается', async () => {
  const { sent, ai } = client({ status: 200, body: message('Вот ответ:\n```json\n{"title":"Т","confident":false}\n```') });
  const result = await ai.complete({ model: 'model-quality-id', system: 's', data: 'd', schema, maxTokens: 10 });
  expect(JSON.parse(sent[0]!.opts.body).model).toBe('model-quality-id');
  expect(result.value).toEqual({ title: 'Т', confident: false });
});

test('ответ не по схеме, не JSON или обрезан пределом токенов: ошибка ответа с потраченными токенами, без текста', async () => {
  for (const [body, code] of [
    [message('{"title": 5}'), 'schema'],
    [message('не JSON'), 'not_json'],
    [message('{"title":"Т","confident":true}', { stop_reason: 'max_tokens' }), 'truncated'],
  ] as const) {
    const { ai } = client({ status: 200, body });
    const error = await ai.complete({ model: 'model-fast-id', system: 's', data: 'd', schema, maxTokens: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiResponseError);
    expect(error).toMatchObject({ code, usage: { inputTokens: 120, outputTokens: 34 } });
    expect(String((error as Error).message)).not.toContain('Т');
  }
  const { ai } = client({ status: 200, body: '<html>' });
  await expect(ai.complete({ model: 'model-fast-id', system: 's', data: 'd', schema, maxTokens: 10 })).rejects.toMatchObject({ code: 'bad_envelope' });
});

test('нет ответа: код HTTP, срок, внутренний адрес, сеть', async () => {
  const cases: [{ status: number; body?: string } | Error, string][] = [
    [{ status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"x"}}' }, 'http_429'],
    [{ status: 529 }, 'http_529'],
    [new OutboundTimeoutError(), 'timeout'],
    [new BlockedAddressError(), 'blocked_address'],
    [new Error('ECONNRESET'), 'unreachable'],
  ];
  for (const [reply, code] of cases) {
    const { ai } = client(reply);
    const error = await ai.complete({ model: 'model-fast-id', system: 's', data: 'd', schema, maxTokens: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error).toMatchObject({ code });
  }
});

// План M5b, решение 3: ответ по схеме JSON, глубина рассуждения, отказ модели и запасной путь сервера.

const firstLineSchema = z.object({ action: z.enum(['answer', 'handoff']), title: z.string().max(80) });

test('схема ответа: output_config.format со схемой JSON без ограничений длины, effort low, без thinking', async () => {
  const { sent, ai } = client({ status: 200, body: message('{"action":"answer","title":"Т"}') });
  await ai.complete({ model: 'claude-haiku-5-5', system: 's', data: 'd', schema: firstLineSchema, maxTokens: 1024, structured: true, effort: 'low' });
  const body = JSON.parse(sent[0]!.opts.body);
  expect(body.output_config.effort).toBe('low');
  expect(body.output_config.format.type).toBe('json_schema');
  const schemaText = JSON.stringify(body.output_config.format.schema);
  expect(schemaText).toContain('"enum":["answer","handoff"]');
  expect(schemaText).toContain('"additionalProperties":false');
  // Ограничения длины API не принимает: их проверяет Zod после ответа.
  expect(schemaText).not.toContain('maxLength');
  expect(schemaText).not.toContain('$schema');
  expect(body.thinking).toBeUndefined();
  // У Haiku запасного пути сервера нет.
  expect(body.fallbacks).toBeUndefined();
  expect(sent[0]!.opts.headers).not.toHaveProperty('anthropic-beta');
});

test('Sonnet и Opus: запасной путь сервера fallbacks default с заголовком беты; ответ запасной модели принимается', async () => {
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    const { sent, ai } = client({ status: 200, body: message('{"action":"handoff","title":"Т"}', { model: 'claude-sonnet-5' }) });
    const result = await ai.complete({ model, system: 's', data: 'd', schema: firstLineSchema, maxTokens: 1024, structured: true, effort: 'low' });
    const body = JSON.parse(sent[0]!.opts.body);
    expect(body.fallbacks).toBe('default');
    expect(sent[0]!.opts.headers).toMatchObject({ 'anthropic-beta': 'server-side-fallback-2026-07-01' });
    // Стоимость считается по модели, которая ответила.
    expect(result.model).toBe('claude-sonnet-5');
  }
});

test('отказ модели (stop_reason refusal): ошибка ответа refusal с токенами, без текста', async () => {
  const { ai } = client({ status: 200, body: message('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }) });
  const error = await ai.complete({ model: 'claude-sonnet-5-5', system: 's', data: 'd', schema: firstLineSchema, maxTokens: 10 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AiResponseError);
  expect(error).toMatchObject({ code: 'refusal', usage: { inputTokens: 120, outputTokens: 34 } });
});

test('блоки рассуждения и переключения модели в ответе пропускаются: JSON берётся только из текста', async () => {
  const body = JSON.stringify({
    type: 'message',
    model: 'claude-sonnet-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
      { type: 'text', text: '{"action":"answer","title":"Т"}' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  const { ai } = client({ status: 200, body });
  const result = await ai.complete({ model: 'claude-sonnet-5-5', system: 's', data: 'd', schema: firstLineSchema, maxTokens: 10, structured: true });
  expect(result.value).toEqual({ action: 'answer', title: 'Т' });
});

// Проверка на AI-инъекции (волна 7, S-T; CLAUDE.md: помощнику нельзя давать инструменты и доступ к базе): ни один
// вид запроса не несёт инструментов, выбора инструмента и серверов MCP.
test('тело запроса к Anthropic не содержит tools, tool_choice и mcp_servers ни в одном режиме', async () => {
  const { readFileSync } = await import('node:fs');
  const requests = [
    { model: 'm', system: 's', data: 'd', schema, maxTokens: 10 },
    { model: 'm', system: 's', data: 'd', schema, maxTokens: 10, structured: true },
    { model: 'm', system: 's', data: 'd', schema, maxTokens: 10, structured: true, effort: 'low' as const },
    { model: 'm', system: 's', data: 'd', schema, maxTokens: 10, timeoutMs: 5000 },
  ];
  for (const request of requests) {
    const { sent, ai } = client({ status: 200, body: message('{"title":"Т","confident":true}') });
    await ai.complete(request);
    const body = JSON.parse(sent[0]!.opts.body) as Record<string, unknown>;
    for (const key of ['tools', 'tool_choice', 'mcp_servers', 'container', 'betas']) expect(Object.keys(body), key).not.toContain(key);
    expect(sent[0]!.opts.body).not.toMatch(/"tools"|"tool_choice"|"mcp_servers"|"tool_use"/);
    expect((sent[0]!.opts.headers as Record<string, string>)['anthropic-beta']).toBeUndefined();
  }
  // И в исходном тексте клиента этих полей нет: добавить инструменты можно только правкой, которую увидит тест.
  const source = readFileSync('src/modules/hda/client/anthropic.ts', 'utf8');
  expect(source).not.toMatch(/\btools\s*:|tool_choice|mcp_servers/);
});
