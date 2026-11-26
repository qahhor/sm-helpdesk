import 'server-only';

// Модуль hdc: нажатие кнопки под ответом Теза в Telegram (план M5b, задача 6). Бот живёт в модуле hdu, а обращения
// в hdt, который стоит выше: hdu знает только этот интерфейс, реализацию даёт hdt, соединяет src/wiring.ts (как
// запись сигнатур, решение 0039).

export type TezFeedbackResult = { ok: true; choice: 'helped' | 'need_staff' } | { ok: false; code: string };
export type TezFeedbackHandler = (userId: string, data: string) => Promise<TezFeedbackResult>;

const shared = globalThis as typeof globalThis & { __hubTezFeedback?: TezFeedbackHandler };

export function registerTezFeedback(handler: TezFeedbackHandler): void {
  shared.__hubTezFeedback = handler;
}

/** Нажатие кнопки Telegram. Не подключено (ошибка сборки процесса): кнопка не действует. */
export async function tezFeedback(userId: string, data: string): Promise<TezFeedbackResult> {
  const handler = shared.__hubTezFeedback;
  return handler ? handler(userId, data) : { ok: false, code: 'link_invalid' };
}
