import 'server-only';

// Модуль hdp, слой api: регистрация источника версии задачи разработки для сборки процесса (src/wiring.ts). Узкий файл
// без зависимостей: сборка процесса не должна тянуть модули уведомлений и пользователей при запуске.

export { type ProblemDevTaskVersion, registerProblemDevTaskVersion } from '../dev-task-version';
