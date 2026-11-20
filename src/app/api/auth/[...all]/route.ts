import { handleAuthRequest } from '@/modules/hdu/api';

// Адреса библиотеки входа. Наружу открыт только возврат с сервера Smartup, остальное отвечает 404:
// вход, сессии и ссылки выполняют серверные действия портала (решение 0012).
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleAuthRequest(request);
}

export function POST(request: Request): Promise<Response> {
  return handleAuthRequest(request);
}
