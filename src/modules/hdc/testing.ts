import 'server-only';

// Модуль hdc: заглушки хранилища и очереди задач для тестов (CLAUDE.md: интерфейс, настоящая реализация и заглушка).
// Не слой api: страницы и другие модули их не видят (правило линтера), их берут только тесты.

export { MemoryJobQueue, setJobQueueForTests } from './jobs';
export { setStorageForTests } from './storage';
export { MemoryStorage } from './storage/memory';
