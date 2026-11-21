import type { StatusTone } from '@/ui/components/StatusLabel';

// Цвет метки статуса обращения у клиента (ТЗ 8.2): цвет один для клиента и сотрудника, смысл несёт текст.
export const STATUS_TONE: Record<string, StatusTone> = {
  new: 'green',
  in_progress: 'orange',
  waiting_customer: 'purple',
  in_development: 'blue',
  resolved: 'teal',
  closed: 'gray',
};

/** Расширения разрешённых файлов для поля выбора (FR-TK-13); image/* открывает камеру и галерею на телефоне. */
export const acceptOf = (extensions: readonly string[]): string => ['image/*', ...extensions.map((ext) => `.${ext}`)].join(',');
