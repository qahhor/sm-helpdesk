import 'server-only';
import { type AnyColumn, ilike, like, type SQL } from 'drizzle-orm';

// Поиск по части текста: единственное место, где портал собирает шаблон LIKE и ILIKE (решение 0041, вопрос 19).
// Функция оператора ILIKE отмечена в базе как безопасная для выполнения раньше условий политик RLS. Отметка честна,
// пока шаблон не может кончаться знаком экранирования: такая ошибка зависела бы от содержимого строки, которую
// человек не видит. Здесь знаки шаблона в тексте человека экранируются, а шаблон всегда кончается знаком "%".
// Вызов ilike и like в остальном коде запрещает правило like-pattern (pnpm check).

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Колонка содержит текст, без учёта регистра. */
export function containsText(column: AnyColumn, text: string): SQL {
  return ilike(column, `%${escapeLike(text)}%`);
}

/** Колонка содержит текст, с учётом регистра. */
export function containsExact(column: AnyColumn, text: string): SQL {
  return like(column, `%${escapeLike(text)}%`);
}
