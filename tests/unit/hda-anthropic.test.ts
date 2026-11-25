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
  return { sent, ai: createAnthropicClient({ apiKey: 'sk-ant-test-key-000', models: { fast: 'model-fast-id', quality: 'model-quality-id' }, post }) };
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

test('запрос: адрес api.anthropic.com/v1/messages, ключ и версия в заголовках, модель уровня из окружения, без инструментов', async () => {
  const { sent, ai } = client({ status: 200, body: message('{"title":"Т","confident":true}') });
  const result = await ai.complete({ tier: 'fast', system: 'ПРАВИЛА', data: '<ticket>данные</ticket>', schema, maxTokens: 1500 });
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

test('качественная модель берётся из своей переменной; JSON в ограждении кода разбирается', async () => {
  const { sent, ai } = client({ status: 200, body: message('Вот ответ:\n```json\n{"title":"Т","confident":false}\n```') });
  const result = await ai.complete({ tier: 'quality', system: 's', data: 'd', schema, maxTokens: 10 });
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
    const error = await ai.complete({ tier: 'fast', system: 's', data: 'd', schema, maxTokens: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiResponseError);
    expect(error).toMatchObject({ code, usage: { inputTokens: 120, outputTokens: 34 } });
    expect(String((error as Error).message)).not.toContain('Т');
  }
  const { ai } = client({ status: 200, body: '<html>' });
  await expect(ai.complete({ tier: 'fast', system: 's', data: 'd', schema, maxTokens: 10 })).rejects.toMatchObject({ code: 'bad_envelope' });
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
    const error = await ai.complete({ tier: 'fast', system: 's', data: 'd', schema, maxTokens: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error).toMatchObject({ code });
  }
});
