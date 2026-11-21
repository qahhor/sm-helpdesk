import { handleLocalStorage } from '@/modules/hdc/api';

// Локальное хранилище файлов на машине разработчика (решение 0027): приём и выдача файла по подписанной ссылке.
// Работает только при FILE_STORAGE=local и адресе портала на localhost, иначе 404.
export const dynamic = 'force-dynamic';

export function PUT(request: Request): Promise<Response> {
  return handleLocalStorage(request);
}

export function GET(request: Request): Promise<Response> {
  return handleLocalStorage(request);
}
