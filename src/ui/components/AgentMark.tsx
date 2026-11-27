import { StatusLabel } from '@/ui/components/StatusLabel';

// Пометка записи AI-сотрудника "AI-сотрудник, не проверено" (ТЗ FR-AGT-07, 14.3; план M8b, решение 22). Текст метки
// приходит со страницы из messages/*.json; цвет только помогает, смысл сообщает текст (WCAG 1.4.1).
export function AgentMark({ label, className }: { label: string; className?: string }) {
  return (
    <StatusLabel tone="purple" className={className}>
      <span data-agent-mark="">{label}</span>
    </StatusLabel>
  );
}
