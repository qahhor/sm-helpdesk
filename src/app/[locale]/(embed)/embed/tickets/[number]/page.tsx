import { notFound } from 'next/navigation';
import { ALLOWED_FILE_EXTENSIONS, MAX_FILES_PER_MESSAGE, parseNumber } from '@/modules/hdt/api';
import { acceptOf } from '@/ui/ticket-status';
import { TicketView } from '@/ui/widget/TicketView';
import { WidgetFrame } from '@/ui/widget/WidgetFrame';

// Обращение в панели виджета (план M6, задача 6; решение 13). Номер из адреса только выбирает, что запросить: видно
// ли обращение, решает API по токену виджета и политикам RLS.
export default async function EmbedTicketPage({ params }: PageProps<'/[locale]/embed/tickets/[number]'>) {
  const number = parseNumber((await params).number);
  if (number === null) notFound();
  return (
    <WidgetFrame active="tickets">
      <TicketView key={number} number={number} accept={acceptOf(ALLOWED_FILE_EXTENSIONS)} maxFiles={MAX_FILES_PER_MESSAGE} />
    </WidgetFrame>
  );
}
