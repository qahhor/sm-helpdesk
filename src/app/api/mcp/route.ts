import { handleMcpRequest } from '@/modules/hda/api/agent';

// Сервер MCP для AI-сотрудников (ТЗ 13, 7.21 FR-AGT-01; план M8b, задача 4; решение 0110). Только POST, без сессии
// портала и без кеша: токен, адрес, пределы и перечень инструментов проверяет handleMcpRequest на каждый запрос.
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export function GET(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export function DELETE(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}
