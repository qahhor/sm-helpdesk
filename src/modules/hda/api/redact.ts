import { orgRedactions, REDACTED, redactTerms, sanitizeForAi } from '../util';

// Модуль hda, слой api: очистка текста от данных клиента для других модулей (план M5, задача 8). Те же правила, что
// перед отправкой в модель (ТЗ 14.3): невидимые знаки, адреса почты, телефоны и длинные числа, известные имена и
// название организации. Модуль знаний строит так пример текста ошибки для списка сигнатур.

/** Текст без почты, телефонов, длинных чисел и известных имён: на их месте метки. */
export function stripClientData(text: string, known: { names?: readonly string[]; orgTerms?: readonly string[] } = {}): string {
  const terms = [...(known.names ?? []).map((term) => ({ term, label: REDACTED.client })), ...orgRedactions(known.orgTerms ?? [], REDACTED.org)];
  return redactTerms(sanitizeForAi(text), terms);
}
