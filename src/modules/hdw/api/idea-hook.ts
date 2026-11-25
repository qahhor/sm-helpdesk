import 'server-only';

// Модуль hdw, слой api: подключение обработчика закрытия задачи идеи (план M7, задача 9). Узкий файл без зависимостей:
// его берёт src/wiring.ts, который импортируют все точки входа до остальных модулей.

export { type ClosedDevTask, type IdeaDevTaskClosedHandler, registerIdeaDevTaskClosed } from '../core/idea-hook';
