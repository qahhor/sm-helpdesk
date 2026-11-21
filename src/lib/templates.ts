// Поиск шаблона ответа по "/" (FR-AG-06, UX-A-05). Чистые функции без зависимостей: их берут и модуль hdr
// на сервере, и поле ответа агента в браузере.

export type Searchable = { shortcut: string; title: string; isEnabled: boolean };

/** Шаблоны для списка "/" (UX-A-05): только включённые; совпадение кода с начала, затем в коде, затем в названии. */
export function filterTemplates<T extends Searchable>(templates: readonly T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase('ru');
  const rank = (t: T): number => {
    if (q === '') return 0;
    const code = t.shortcut.toLocaleLowerCase('ru');
    if (code.startsWith(q)) return 0;
    if (code.includes(q)) return 1;
    return t.title.toLocaleLowerCase('ru').includes(q) ? 2 : -1;
  };
  return templates
    .filter((t) => t.isEnabled)
    .map((t, index) => ({ t, index, r: rank(t) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .map((x) => x.t);
}

/** "/" в начале слова перед кареткой: откуда начинается код и что набрано после "/". Иначе null. */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)\/([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: match.index + (match[1]?.length ?? 0), query: match[2] ?? '' };
}

