import { ALLOWED_FILE_EXTENSIONS, MAX_FILES_PER_MESSAGE } from '@/modules/hdt/api';
import { acceptOf } from '@/ui/ticket-status';
import { ReportView } from '@/ui/widget/ReportView';
import { WidgetFrame } from '@/ui/widget/WidgetFrame';

// "Сообщить" в панели виджета (ТЗ 8.3, FR-WG-03, 06; план M6, задача 5). Данные приходят после обмена токена:
// страница на сервере не знает пользователя и не читает сессию.
export default function EmbedReportPage() {
  return (
    <WidgetFrame active="report">
      <ReportView accept={acceptOf(ALLOWED_FILE_EXTENSIONS)} maxFiles={MAX_FILES_PER_MESSAGE} />
    </WidgetFrame>
  );
}
