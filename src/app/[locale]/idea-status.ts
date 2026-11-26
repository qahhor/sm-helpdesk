import type { IdeaStatus } from '@/modules/hdi/api/constants';
import type { StatusTone } from '@/ui/components/StatusLabel';

// Тон метки статуса идеи: общий для доски клиента, главной и рабочего места (ТЗ 8.3, FR-IDEA-08). Подпись статуса
// берётся из client.ideas.statuses.<статус>: у клиента и сотрудника одни и те же слова.

export const IDEA_STATUS_TONE: Record<IdeaStatus, StatusTone> = {
  pending_review: 'gray',
  open: 'blue',
  shortlisted: 'purple',
  selected: 'teal',
  in_development: 'orange',
  released: 'green',
  declined: 'danger',
  merged: 'gray',
};
