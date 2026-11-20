import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser';
import type { Messages } from './messages';

// Проверка строк сообщений при загрузке. Строка, которая не разбирается или просит другие
// подстановки, чем русская, показала бы посетителю имя ключа. Такая строка отбрасывается,
// и на её место встаёт текст запасного языка (FR-I18N-05). В CI ту же ошибку ловит pnpm check.

/** Имена подстановок строки ICU или null, если строка не разбирается. */
export function icuArguments(message: string): Set<string> | null {
  const names = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if (element.type === TYPE.literal || element.type === TYPE.pound) continue;
      names.add(element.value);
      if (element.type === TYPE.plural || element.type === TYPE.select)
        for (const option of Object.values(element.options)) walk(option.value);
      if (element.type === TYPE.tag) walk(element.children);
    }
  };
  try {
    walk(parse(message));
    return names;
  } catch {
    return null;
  }
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((name) => b.has(name));

/** Сообщения без сломанных строк. reference: сообщения эталонного языка (русского). */
export function dropBrokenMessages(messages: Messages, reference: Messages | undefined): Messages {
  const result: Messages = {};
  for (const [key, value] of Object.entries(messages)) {
    const expected = reference?.[key];
    if (typeof value === 'object') {
      result[key] = dropBrokenMessages(value, typeof expected === 'object' ? expected : undefined);
      continue;
    }
    const own = icuArguments(value);
    if (!own) continue;
    const wanted = typeof expected === 'string' ? icuArguments(expected) : null;
    if (wanted && !sameSet(own, wanted)) continue;
    result[key] = value;
  }
  return result;
}
