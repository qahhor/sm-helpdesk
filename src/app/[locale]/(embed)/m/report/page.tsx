import { getLocale } from 'next-intl/server';
import { ALLOWED_FILE_EXTENSIONS, MAX_FILES_PER_MESSAGE } from '@/modules/hdt/api';
import { acceptOf } from '@/ui/ticket-status';
import { MobileApp } from '@/ui/widget/MobileApp';
import { widgetLabels } from '../../labels';

// Страница для мобильного приложения (план M6, задача 7; FR-WG-08, ТЗ 11.9): /{язык}/m/report#ctx=<токен>. Те же
// экраны, что в панели виджета, на весь экран. Сессию портала не читает (прокси удаляет Cookie), Referer не отдаёт
// (next.config.ts), во фрейм не встраивается. Токен контекста во фрагменте сервер не видит никогда.
export default async function MobileReportPage() {
  return <MobileApp locale={await getLocale()} labels={await widgetLabels()} accept={acceptOf(ALLOWED_FILE_EXTENSIONS)} maxFiles={MAX_FILES_PER_MESSAGE} />;
}
