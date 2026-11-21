// Цвет метки статуса общий для клиента и сотрудника: src/ui/ticket-status.ts.
export { STATUS_TONE } from '@/ui/ticket-status';

/** Расширения разрешённых файлов для поля выбора (FR-TK-13); image/* открывает камеру и галерею на телефоне. */
export const acceptOf = (extensions: readonly string[]): string => ['image/*', ...extensions.map((ext) => `.${ext}`)].join(',');
