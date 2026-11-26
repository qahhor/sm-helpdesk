// Ключи очередей и сортировок рабочего места (FR-AG-01, FR-AG-18). Без базы: их берут схемы входа и экраны.

// after_ai и ai_waiting (план M5b, задача 8, решение 19; FR-AG-19): переданное помощником, по которому сотрудник ещё
// не ответил, и обращения, где помощник ответил, а клиент молчит.
export const QUEUE_KEYS = ['new', 'mine', 'after_ai', 'ai_waiting', 'l2', 'waiting', 'development', 'breached', 'all'] as const;
export type QueueKey = (typeof QUEUE_KEYS)[number];
export const QUEUE_SORTS = ['sla', 'client_waiting', 'updated'] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];
