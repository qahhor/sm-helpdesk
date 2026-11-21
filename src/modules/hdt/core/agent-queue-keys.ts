// Ключи очередей и сортировок рабочего места (FR-AG-01, FR-AG-18). Без базы: их берут схемы входа и экраны.

export const QUEUE_KEYS = ['new', 'mine', 'l2', 'waiting', 'development', 'breached', 'all'] as const;
export type QueueKey = (typeof QUEUE_KEYS)[number];
export const QUEUE_SORTS = ['sla', 'client_waiting', 'updated'] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];
