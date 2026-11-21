import type { StatusTone } from '@/ui/components/StatusLabel';

// Цвет метки статуса обращения (ТЗ 8.2): один для клиента и сотрудника, смысл несёт текст.
export const STATUS_TONE: Record<string, StatusTone> = {
  new: 'green',
  in_progress: 'orange',
  waiting_customer: 'purple',
  in_development: 'blue',
  resolved: 'teal',
  closed: 'gray',
};
