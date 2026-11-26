import type { SearchReader } from './types';

// Путь PostgreSQL (план W6, решение 15, SEARCH_PROVIDER=postgres, по умолчанию): Typesense не вызывается, каждый поиск
// сразу даёт Fallback "disabled", и вызывающий идёт прежними запросами (containsText, hybridSearchTx). Это не сбой:
// событие search.fallback и счётчик откатов его не учитывают.

export function createPostgresReader(): SearchReader {
  return {
    name: 'postgres',
    async searchIds() {
      return { kind: 'fallback', reason: 'disabled' };
    },
  };
}
