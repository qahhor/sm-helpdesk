import 'server-only';

// Модуль hdw (автоматизация), слой api: точки входа модуля для страниц (docs/naming.md, раздел 5). Применение правил
// для фонового процесса лежит в узком файле api/engine.ts, отправка вебхуков в api/webhook-jobs.ts.

export * from './api/macros';
export * from './api/rules';
export * from './api/webhooks';
