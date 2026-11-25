import { TicketsView } from '@/ui/widget/TicketsView';
import { WidgetFrame } from '@/ui/widget/WidgetFrame';

// "Мои обращения" в панели виджета (план M6, задача 6; FR-WG-06, решение 13). Список приходит после обмена токена.
export default function EmbedTicketsPage() {
  return (
    <WidgetFrame active="tickets">
      <TicketsView />
    </WidgetFrame>
  );
}
