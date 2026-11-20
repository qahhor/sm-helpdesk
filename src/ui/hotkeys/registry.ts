// Горячие клавиши рабочего места (UX-S-14). Совпадают с клавишами Smartup Web там, где действие то же.
// Источник значений: окно "Горячие клавиши" Smartup Web (снимок 3.13 поставки).
// Здесь только список. Обработчики появляются вместе с экранами.

export type Hotkey = { keys: string; action: string };

export const HOTKEYS: readonly Hotkey[] = [
  // Палитра команд с поиском открывается двумя сочетаниями: как в Smartup Web и как привычно в вебе (UX-A-02).
  { keys: 'F2', action: 'palette.open' },
  { keys: 'Ctrl+K', action: 'palette.open' },
  // Таблица данных
  { keys: 'F3', action: 'table.search' },
  { keys: 'F4', action: 'table.filter' },
  { keys: 'F7', action: 'table.refresh' },
  // На снимке поставки строки F8 и F9 не видны. Клавиши заняты за Smartup Web,
  // их действие уточняется у разработчиков Smartup (docs/plans/README.md, раздел 7.1).
  { keys: 'F8', action: 'smartup.f8' },
  { keys: 'F9', action: 'smartup.f9' },
  // Форма и страница
  { keys: 'Alt+A', action: 'record.add' },
  { keys: 'Alt+E', action: 'record.edit' },
  { keys: 'Alt+S', action: 'form.save' },
  { keys: 'Alt+Q', action: 'page.close' },
  { keys: 'Ctrl+Enter', action: 'form.complete' },
];
