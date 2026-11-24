'use client';

import { useEffect } from 'react';
import { markSeenAction } from './actions';

/**
 * Ставит отметку "просмотрено", когда страница обращения показана в браузере. На экране ничего не рисует.
 * Отметки "новое" на странице уже посчитаны по прежнему визиту, поэтому до следующего открытия они остаются.
 */
export function SeenMark({ ticketId }: { ticketId: string }) {
  useEffect(() => {
    void markSeenAction(ticketId).catch(() => undefined);
  }, [ticketId]);
  return null;
}
