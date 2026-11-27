import type { ProblemStatus } from '@/modules/hdp/api';
import type { StatusTone } from '@/ui/components/StatusLabel';

// Тон метки статуса известной проблемы (FR-KP-02): статус сообщается текстом, цвет только помогает.
export const PROBLEM_STATUS_TONE: Record<ProblemStatus, StatusTone> = { draft: 'teal', investigating: 'orange', cause_found: 'purple', fixing: 'blue', fixed: 'green', closed: 'gray' };
