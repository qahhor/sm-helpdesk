import { staffSystemText } from './system-text';

// Модуль hdt: текст непроверенного письма для внутренней заметки (аудит 23.11.2026, находка S12).

/** Адрес в тексте письма: со схемой (https://, ftp://, tg://) или начинающийся с www. */
const LINK = /\b(?:[a-z][a-z0-9+.-]{1,15}:\/\/|www\.)[^\s<>"']+/giu;

/**
 * Текст без ссылок: ссылка заменяется отметкой с именем узла. По узлу видно, куда она вела, но скопировать
 * и открыть её нельзя.
 */
export function withoutLinks(text: string, locale: string): string {
  return text.replace(LINK, (link) => {
    try {
      const host = new URL(/^www\./i.test(link) ? `http://${link}` : link).hostname;
      return host ? staffSystemText(locale, 'linkRemoved', { host: host.slice(0, 120) }) : staffSystemText(locale, 'linkRemovedNoHost', {});
    } catch {
      return staffSystemText(locale, 'linkRemovedNoHost', {});
    }
  });
}

/** Знаки, которыми Markdown строит ссылки, картинки, код и выделение, и знак, которым он их отменяет. */
const MARKDOWN_MARKS = /[\\`*_[\]()<>&!]/g;

/**
 * Текст непроверенного письма для заметки сотруднику. Заметку показывает разметка Markdown, поэтому убрать адреса
 * мало: разметка сама собирает ссылку из частей ("[Войти](https:\//узел)", "https&colon;//узел", ссылка по сноске,
 * адрес почты в угловых скобках). После замены адресов все знаки разметки экранируются: на экране остаётся текст
 * письма как он есть, без единой ссылки (итоговая проверка волны 1, замечание F1).
 */
export function untrustedNoteText(text: string, locale: string): string {
  return withoutLinks(text, locale).replace(MARKDOWN_MARKS, (mark) => `\\${mark}`);
}
