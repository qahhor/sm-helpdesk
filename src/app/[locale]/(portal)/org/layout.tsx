import { notFound } from 'next/navigation';
import { requireClientActor } from '@/modules/hdu/api';

// Страница организации только администратору клиента. Проверка стоит здесь, выше границы загрузки (loading.tsx):
// внутри неё ответ уже начал передаваться, и 404 пришёл бы с кодом 200. Страница проверяет роль ещё раз.
export default async function OrgLayout({ children }: LayoutProps<'/[locale]/org'>) {
  const client = await requireClientActor();
  if (client.actor.orgRole !== 'client_admin') notFound();
  return children;
}
