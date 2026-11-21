'use client';

import { useEffect } from 'react';
import { browserDrafts, clearDraft, draftKey } from '@/ui/drafts';

/**
 * Удаляет черновики после успешной отправки: страница, куда ведёт отправка, ставит этот компонент (FR-TK-16).
 * Затем убирает из адреса отметку успеха (created, done): иначе перезагрузка страницы стёрла бы новый черновик.
 */
export function DraftCleaner({ userId, scopes }: { userId: string; scopes: readonly string[] }) {
  useEffect(() => {
    for (const scope of scopes) clearDraft(browserDrafts(), draftKey(userId, scope));
    const url = new URL(window.location.href);
    url.searchParams.delete('created');
    url.searchParams.delete('done');
    window.history.replaceState(window.history.state, '', url);
  }, [userId, scopes]);
  return null;
}
