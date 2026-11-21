// Горячие клавиши рабочего места (UX-S-14). Совпадают с клавишами Smartup Web там, где действие то же.
// Источник значений: окно "Горячие клавиши" Smartup Web (снимок 3.13 поставки).
// Здесь список и сопоставление нажатия с действием. Обработчики регистрируют экраны (src/ui/hotkeys/bus.ts).

export type Hotkey = { keys: string; action: string };

export const HOTKEYS: readonly Hotkey[] = [
  // Палитра команд с поиском открывается двумя сочетаниями: как в Smartup Web и как привычно в вебе (UX-A-02).
  { keys: 'F2', action: 'palette.open' },
  { keys: 'Ctrl+K', action: 'palette.open' },
  // Таблица данных
  { keys: 'F3', action: 'table.search' },
  { keys: 'F4', action: 'table.filter' },
  { keys: 'F7', action: 'table.refresh' },
  // F8 и F9 в портале не используются: своих действий на них нет, действия Smartup Web не повторяются
  // (решение владельца от 20.11.2026, ТЗ 1.1, UX-S-14).
  // Форма и страница
  { keys: 'Alt+A', action: 'record.add' },
  { keys: 'Alt+E', action: 'record.edit' },
  { keys: 'Alt+S', action: 'form.save' },
  { keys: 'Alt+Q', action: 'page.close' },
  { keys: 'Ctrl+Enter', action: 'form.complete' },
  // Рабочее место (UX-A-01..04, UX-A-17; план M3, задача 14). Буквы без сочетаний: только вне полей ввода.
  { keys: 'Ctrl+Shift+Enter', action: 'reply.sendNext' },
  { keys: 'R', action: 'reply.focus' },
  { keys: 'N', action: 'note.focus' },
  { keys: 'T', action: 'ticket.take' },
  { keys: 'S', action: 'ticket.snooze' },
  { keys: 'ArrowDown', action: 'list.next' },
  { keys: 'ArrowUp', action: 'list.prev' },
  { keys: '?', action: 'help.open' },
];

export type KeyInput = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

/**
 * Действие для нажатия или null. Буквы берутся по физической клавише (code), чтобы работали в любой раскладке;
 * Cmd на Mac считается Ctrl. В поле ввода срабатывают только сочетания с Ctrl: набор текста не мешает.
 */
export function matchHotkey(event: KeyInput, inField: boolean): string | null {
  const ctrl = event.ctrlKey || event.metaKey;
  if (inField && !ctrl) return null;
  const letter = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : null;
  const symbol = !letter && event.key.length === 1 ? event.key : null;
  const main = letter ?? symbol ?? event.key;
  // Знак вроде "?" набирается с Shift: Shift в нём уже учтён.
  const parts = [ctrl ? 'Ctrl' : null, event.shiftKey && !symbol ? 'Shift' : null, event.altKey ? 'Alt' : null, main].filter(Boolean);
  const combo = parts.join('+');
  return HOTKEYS.find((h) => h.keys === combo)?.action ?? null;
}
