import 'server-only';
import type { Locale } from '@/i18n/locales';

// Модуль hdc: справочник контактов, "куда писать человеку" (аудит 23.11.2026, находка A1; план W2, задача 8).
// Уведомлениям (hdn) нужны адрес почты и чат Telegram человека, а знает их модуль пользователей (hdu). Раньше hdn
// брал их прямо из hdu, а hdu отправлял письма через hdn: два модуля зависели друг от друга. Теперь интерфейс
// объявлен здесь, реализацию даёт hdu, подключает её файл src/wiring.ts при запуске процесса. hdn знает только hdc.

/** Адрес для письма: подтверждённый адрес пользователя и его язык. */
export type MailContact = { address: string; locale: Locale | null };
/** Чат Telegram: действующая привязка без блокировки бота. */
export type TelegramContact = { chatId: string; locale: Locale | null };

export interface ContactDirectory {
  /** Адрес для письма пользователю или null: адреса нет или он не подтверждён. */
  mailRecipient(userId: string): Promise<MailContact | null>;
  /** Чат Telegram пользователя или null: не привязан или бот заблокирован. */
  telegramChat(userId: string): Promise<TelegramContact | null>;
  /** Привязан ли Telegram и не заблокирован ли бот. */
  telegramLinked(userId: string): Promise<boolean>;
  /** У кого из пользователей действует привязка Telegram: одним запросом на всех. */
  telegramLinkedMany(userIds: string[]): Promise<Set<string>>;
  /** Telegram ответил 403 на сообщение в этот чат: бот заблокирован, уведомления в Telegram прекращаются. */
  markTelegramBlocked(chatId: string): Promise<void>;
}

const shared = globalThis as typeof globalThis & { __hubContacts?: ContactDirectory };

/** Подключает справочник. Вызывается один раз при запуске процесса из src/wiring.ts. */
export function registerContactDirectory(directory: ContactDirectory): void {
  shared.__hubContacts = directory;
}

/** Справочник контактов. Не подключён: ошибка запуска, а не тихая потеря уведомлений. */
export function contacts(): ContactDirectory {
  if (!shared.__hubContacts) throw new Error('Справочник контактов не подключён: точка входа процесса должна импортировать src/wiring.ts');
  return shared.__hubContacts;
}
