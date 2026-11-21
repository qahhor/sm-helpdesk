// Тема обращения из описания (FR-TK-02). Чистая функция без зависимостей: её берут и модуль hdt на сервере,
// и форма нового обращения в браузере, чтобы подстановка при вводе совпала с тем, что сохранит сервер.

const TITLE_MAX = 80;

/**
 * Тема обращения из описания (FR-TK-02): первая строка, из неё первое предложение без конечного знака,
 * не длиннее 80 знаков с обрезкой по границе слова. Клиент может поправить тему.
 */
export function titleFromDescription(description: string): string {
  const firstLine = description.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const sentence = (/^(.*?[^.!?])[.!?]+(\s|$)/u.exec(firstLine)?.[1] ?? firstLine).trim();
  const chars = Array.from(sentence);
  if (chars.length <= TITLE_MAX) return sentence;
  const cut = chars.slice(0, TITLE_MAX).join('');
  const space = cut.lastIndexOf(' ');
  return space > 0 ? cut.slice(0, space).trimEnd() : cut;
}
