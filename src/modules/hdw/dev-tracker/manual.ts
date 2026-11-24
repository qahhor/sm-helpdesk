import type { DevTracker } from './types';

// Модуль hdw: ручная реализация DevTracker (FR-DEV-02; решение 12 плана M8). Никуда не обращается: номер, ссылку и
// название задачи вводит сотрудник, статус задачи он же меняет на странице обращения. Портал задачу не создаёт и
// не опрашивает, поэтому createTask в ручном режиме не вызывается, а getTask ничего не знает о задаче.

export function createManualTracker(): DevTracker {
  return {
    async createTask() {
      throw new Error('Таск-менеджер в ручном режиме: задачу заводит сотрудник, портал её не создаёт');
    },
    async getTask() {
      return null;
    },
  };
}
