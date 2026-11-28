import { notFound } from 'next/navigation';
import { requireStaffActor } from '@/modules/hdu/api';

// Неизвестный адрес рабочего места (проверка интерфейса, U7): "не найдено" внутри оболочки сотрудника. Без этой
// страницы адрес /agent/что-угодно показывал общую страницу без меню. Гость уходит на вход, как с любой страницы
// рабочего места: о том, каких адресов нет, он не узнаёт.
export default async function AgentUnknownPage() {
  await requireStaffActor();
  notFound();
}
