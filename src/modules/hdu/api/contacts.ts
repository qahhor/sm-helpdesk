import 'server-only';
import type { ContactDirectory } from '@/modules/hdc/api';
import { mailRecipient, markTelegramBlocked, telegramChat, telegramLinked, telegramLinkedMany } from './recipients';

// Модуль hdu, слой api: справочник контактов для уведомлений (аудит 23.11.2026, находка A1). Интерфейс объявлен
// в hdc, подключает реализацию src/wiring.ts. Узкий файл: его берёт и фоновый процесс.

export const contactDirectory: ContactDirectory = { mailRecipient, telegramChat, telegramLinked, telegramLinkedMany, markTelegramBlocked };
