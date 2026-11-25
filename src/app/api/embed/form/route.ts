import { handleEmbedForm } from '@/modules/hdt/api/embed';

// Поля формы виджета: действующие модули с кодом для подсказки модуля (план M6, задача 5; UX-C-09). Токен виджета.
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleEmbedForm(request);
}
