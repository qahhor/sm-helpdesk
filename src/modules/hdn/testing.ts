import 'server-only';

// Модуль hdn: заглушки внешних сервисов для тестов (CLAUDE.md: интерфейс, настоящая реализация и заглушка).
// Не слой api: страницы и другие модули их не видят (правило линтера), их берут только тесты (проверка main, Q15).

export { MemoryMailer, setMailerForTests } from './mailer';
export { MemoryTelegramBot, setTelegramBotForTests } from './telegram';
