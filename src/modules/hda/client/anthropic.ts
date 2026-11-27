import * as z from 'zod';
import { BlockedAddressError, type GuardedPost, guardedPostJson, OutboundTimeoutError } from '@/security/outbound';
import { AI_RESPONSE_MAX_BYTES, AI_TIMEOUT_MS, SERVER_FALLBACK_BETA, SERVER_FALLBACK_MODELS } from '../pref';
import { extractJson } from '../util';
import { type AiClient, type AiRequest, type AiResult, AiResponseError, AiUnavailableError } from './types';

// Модуль hda: тонкий клиент Anthropic Messages API без пакета SDK (план M5, решение 4). Весь договор с API в этом
// файле: если владелец выберет пакет @anthropic-ai/sdk или договор API изменится, меняется только он.
//
// ВНИМАНИЕ: клиент не проверялся на настоящем API (ключа и доступа к api.anthropic.com в среде разработки нет).
// Формат запроса и ответа взят из описания Messages API и проверен только юнит-тестами с подменой запроса
// (tests/unit/hda-anthropic.test.ts). Первая проверка на настоящем ключе: docs/decisions/0050-claude-client.md.
//
// Запрос:  POST https://api.anthropic.com/v1/messages
//          x-api-key: <ключ>, anthropic-version: 2023-06-01, content-type: application/json
//          { model, max_tokens, system, messages: [{ role: 'user', content: <данные> }] }
// Ответ:   { type: 'message', model, content: [{ type: 'text', text }], stop_reason, usage: { input_tokens, output_tokens } }
//
// План M5b, решение 3 (тоже не проверено на настоящем API):
//   - structured: ответ по схеме JSON, output_config.format = { type: 'json_schema', schema } (схема из той же схемы Zod,
//     без ограничений длины и чисел: API их не принимает, Zod проверяет ответ всё равно); effort в output_config.
//     Поля thinking нет: у моделей 5.5 рассуждение адаптивное по умолчанию, отключение возвращает 400.
//   - stop_reason 'refusal' и 'max_tokens': AiResponseError с кодом refusal или truncated.
//   - Sonnet и Opus: запасной путь сервера при отказе (fallbacks: 'default', заголовок беты server-side-fallback-2026-07-01);
//     у Haiku его нет. Ответ запасной модели принимается, стоимость считается по модели из ответа.
//
// Инструментов в запросе нет: модель не может ничего вызвать. Запрос идёт через защищённый сетевой слой
// (src/security/outbound.ts): только https, внутренние адреса отклоняются при соединении, переадресаций нет. Адрес
// единственный и задан здесь, из окружения он не берётся.

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

const responseSchema = z.object({
  type: z.literal('message'),
  model: z.string().max(200),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }).loose(),
}).loose();

export type AnthropicConfig = {
  apiKey: string;
  timeoutMs?: number;
  /** Подмена запроса в тестах: проверяет точный вид запроса без сети. */
  post?: GuardedPost;
};

const failureCode = (error: unknown): string =>
  error instanceof OutboundTimeoutError ? 'timeout' : error instanceof BlockedAddressError ? 'blocked_address' : 'unreachable';

export function createAnthropicClient(config: AnthropicConfig): AiClient {
  const post = config.post ?? guardedPostJson;
  return {
    async complete<T>(request: AiRequest<T>): Promise<AiResult<T>> {
      const model = request.model;
      const fallback = SERVER_FALLBACK_MODELS.includes(model);
      const outputConfig = {
        ...(request.structured ? { format: { type: 'json_schema', schema: apiJsonSchema(request.schema) } } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
      };
      const body = JSON.stringify({
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.data }],
        ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
        ...(fallback ? { fallbacks: 'default' } : {}),
      });
      let response: { status: number; body?: string };
      try {
        response = await post({ allowLoopback: false }, ANTHROPIC_URL, {
          body,
          headers: {
            'x-api-key': config.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            accept: 'application/json',
            ...(fallback ? { 'anthropic-beta': SERVER_FALLBACK_BETA } : {}),
          },
          timeoutMs: request.timeoutMs ?? config.timeoutMs ?? AI_TIMEOUT_MS,
          maxResponseBytes: AI_RESPONSE_MAX_BYTES,
          readBody: true,
        });
      } catch (error) {
        throw new AiUnavailableError(failureCode(error));
      }
      if (response.status < 200 || response.status >= 300) throw new AiUnavailableError(`http_${response.status}`);
      let parsed: z.infer<typeof responseSchema>;
      try {
        parsed = responseSchema.parse(JSON.parse(response.body ?? ''));
      } catch {
        throw new AiResponseError('bad_envelope', model, { inputTokens: 0, outputTokens: 0 });
      }
      const usage = { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens };
      // Ответ обрезан пределом токенов: JSON неполный, даже если разберётся частично.
      if (parsed.stop_reason === 'max_tokens') throw new AiResponseError('truncated', parsed.model, usage);
      // Отказ модели (и запасной модели, если путь был): ответа нет.
      if (parsed.stop_reason === 'refusal') throw new AiResponseError('refusal', parsed.model, usage);
      const text = parsed.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      const json = extractJson(text);
      if (json === null) throw new AiResponseError('not_json', parsed.model, usage);
      const value = request.schema.safeParse(json);
      if (!value.success) throw new AiResponseError('schema', parsed.model, usage);
      return { value: value.data, model: parsed.model, usage };
    },
  };
}

/** Ключи схемы, которых API структурного ответа не принимает: их проверяет Zod после ответа. */
const UNSUPPORTED = new Set(['$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'pattern']);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => !UNSUPPORTED.has(key)).map(([key, value]) => [key, strip(value)]));
}

/** Схема JSON для output_config.format из схемы Zod: объекты закрыты (additionalProperties: false), ограничения сняты. */
export function apiJsonSchema(schema: z.ZodType): unknown {
  return strip(z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }));
}
