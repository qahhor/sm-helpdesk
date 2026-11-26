import { type AiClient, type AiRequest, type AiResult, AiResponseError } from './types';
import type { AiTier } from '../pref';

// Модуль hda: заглушка модели (ТЗ 11.11: у каждого внешнего сервиса есть заглушка; план M5, задача 5). Отвечает
// заготовленными ответами и записывает каждый запрос: тесты проверяют, что ушло в модель, по телу запроса.
//
// Ответ выбирается функцией respond(request): тест кладёт свой ответ (в том числе с инъекцией) или ошибку.
// Без функции ответ строит defaultStubResponse: для разработки и браузерных тестов (AI_STUB=1).

export type StubCall = { tier: AiTier; system: string; data: string; maxTokens: number };
export type StubResponder = (call: StubCall) => unknown;

export const STUB_MODEL = 'stub-model';

/** Заготовка: черновик решения по разделу 11.10 или перевод (решения, идеи), возвращающий тексты без изменений. */
export function defaultStubResponse(call: StubCall): unknown {
  if (call.data.includes('<ticket>'))
    return {
      title: 'Документ не проводится из-за закрытого периода',
      problem: 'При проведении документа появляется сообщение о закрытом периоде.',
      steps: ['Откройте настройки периода.', 'Откройте период и проведите документ снова.'],
      confident: true,
    };
  // Перевод идеи (план M7): заголовок и описание без изменений.
  const idea = /<idea>\s*<title>([\s\S]*?)<\/title>\s*<body>([\s\S]*?)<\/body>/.exec(call.data);
  if (idea) return { title: idea[1], body: idea[2] };
  const segments = [...call.data.matchAll(/<segment id="([^"]+)">([\s\S]*?)<\/segment>/g)].map((m) => ({ id: m[1], text: m[2] }));
  return { segments };
}

export class StubAiClient implements AiClient {
  readonly calls: StubCall[] = [];
  respond: StubResponder | null;

  constructor(respond: StubResponder | null = null) {
    this.respond = respond;
  }

  async complete<T>(request: AiRequest<T>): Promise<AiResult<T>> {
    const call = { tier: request.tier, system: request.system, data: request.data, maxTokens: request.maxTokens };
    this.calls.push(call);
    const raw = (this.respond ?? defaultStubResponse)(call);
    if (raw instanceof Error) throw raw;
    const usage = { inputTokens: Math.ceil((request.system.length + request.data.length) / 4), outputTokens: Math.ceil(JSON.stringify(raw ?? null).length / 4) };
    const value = request.schema.safeParse(raw);
    if (!value.success) throw new AiResponseError('schema', STUB_MODEL, usage);
    return { value: value.data, model: STUB_MODEL, usage };
  }
}
