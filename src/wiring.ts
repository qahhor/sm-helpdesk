import { registerContactDirectory, registerTicketSignatureRecorder } from '@/modules/hdc/api';
import { ticketSignatureRecorder } from '@/modules/hdk/api/signatures';
import { contactDirectory } from '@/modules/hdu/api/contacts';
import { embedOriginsByKey } from '@/modules/hdu/api/servers';
import { registerEmbedOriginsLoader } from '@/security/embed-frame';
import { registerIdeaDevTaskClosed } from '@/modules/hdw/api/idea-hook';

// Сборка процесса: связи между модулями, которые идут через интерфейсы общего модуля (аудит 23.11.2026,
// находка A1). Модуль уведомлений не знает модуля пользователей: справочник контактов объявлен в hdc, реализацию
// даёт hdu, а здесь они соединяются. Файл импортирует каждая точка входа: сервер Next.js (instrumentation-node.ts),
// фоновый процесс (worker/main.ts), команда консоли (cli/main.ts) и настройка тестов с базой. Тест
// tests/unit/wiring.test.ts проверяет, что ни одна точка входа его не потеряла.

registerContactDirectory(contactDirectory);
// Сигнатуру ошибки нового обращения (план M5, задача 8) считает модуль знаний hdk: hdt знает только интерфейс в hdc.
registerTicketSignatureRecorder(ticketSignatureRecorder);
// Адреса встраивания страниц виджета для прокси (план M6, задача 3): прокси к базе не ходит, список читает из памяти
// процесса, а загружает его этот загрузчик. В фоновом процессе и команде консоли он не вызывается ни разу.
registerEmbedOriginsLoader(embedOriginsByKey);
// Закрытие задачи разработки идеи (план M7, задача 9): hdw не знает идей, уведомление роли product ставит модуль hdi.
// Модуль идей загружается при первом закрытии задачи: сборка процесса не тянет его (и его зависимости) при запуске.
registerIdeaDevTaskClosed(async (tx, ideaIds, task) => (await import('@/modules/hdi/api/dev-closed')).ideaDevTaskClosed(tx, ideaIds, task));
