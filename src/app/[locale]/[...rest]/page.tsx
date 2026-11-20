import { notFound } from 'next/navigation';

// Любой неизвестный адрес внутри языка показывает страницу "не найдено" на этом языке.
export default function UnknownPage() {
  notFound();
}
