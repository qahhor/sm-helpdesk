import { registerContactDirectory } from '@/modules/hdc/api';
import { contactDirectory } from '@/modules/hdu/api/contacts';

// Сборка процесса: связи между модулями, которые идут через интерфейсы общего модуля (аудит 23.11.2026,
// находка A1). Модуль уведомлений не знает модуля пользователей: справочник контактов объявлен в hdc, реализацию
// даёт hdu, а здесь они соединяются. Файл импортирует каждая точка входа: сервер Next.js (instrumentation-node.ts),
// фоновый процесс (worker/main.ts), команда консоли (cli/main.ts) и настройка тестов с базой. Тест
// tests/unit/wiring.test.ts проверяет, что ни одна точка входа его не потеряла.

registerContactDirectory(contactDirectory);
