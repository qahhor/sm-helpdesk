// Разделы кабинета клиента. Пятый пункт "База знаний" добавится на этапе 2.
// Подписи лежат в сообщениях: client.nav.<key>.

export const CLIENT_NAV = [
  { key: 'home', href: '/', icon: 'House' },
  { key: 'tickets', href: '/tickets', icon: 'MessageSquareText' },
  { key: 'ideas', href: '/ideas', icon: 'Lightbulb' },
  { key: 'profile', href: '/settings', icon: 'UserRound' },
] as const satisfies readonly { key: string; href: string; icon: string }[];

export type ClientNavKey = (typeof CLIENT_NAV)[number]['key'];
export type ClientNavItem = { key: ClientNavKey; href: string; label: string };

/** Открыт ли раздел: главная только по точному адресу, остальные вместе с вложенными страницами. */
export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
