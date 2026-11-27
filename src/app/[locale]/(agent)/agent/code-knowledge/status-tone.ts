import type { CodeEntryStatus } from '@/modules/hda/api/constants';
import type { StatusTone } from '@/ui/components/StatusLabel';

// Цвет метки статуса записи каталога ошибок и заметки о модуле (8.11: цвет не единственный носитель смысла, рядом текст).
export const CODE_STATUS_TONE: Record<CodeEntryStatus, StatusTone> = { draft: 'purple', approved: 'green', rejected: 'gray', removed: 'gray' };
