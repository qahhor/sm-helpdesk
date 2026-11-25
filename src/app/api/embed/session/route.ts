import { handleEmbedSession } from '@/modules/hdu/api/embed';

// Обмен токена контекста на токен виджета (ТЗ 11.4; план M6, задача 2). Кук нет: токен виджета живёт в памяти
// страницы виджета. Проверки запроса, пределы и журнал: в handleEmbedSession.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleEmbedSession(request);
}
