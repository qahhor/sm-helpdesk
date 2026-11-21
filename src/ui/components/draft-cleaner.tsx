'use client';

import { useEffect } from 'react';
import { browserDrafts, browserSession, clearIfSent, draftKey } from '@/ui/drafts';

/**
 * Удаляет черновик после успешной отправки, только если на устройстве лежит именно отправленный текст: страница,
 * куда ведёт отправка, ставит этот компонент (FR-TK-16). Затем убирает из адреса отметку успеха (created, done).
 */
export function DraftCleaner({ userId, scopes }: { userId: string; scopes: readonly string[] }) {
  useEffect(() => {
    for (const scope of scopes) clearIfSent(browserDrafts(), browserSession(), draftKey(userId, scope));
    const url = new URL(window.location.href);
    url.searchParams.delete('created');
    url.searchParams.delete('done');
    // Next.js связывает replaceState со своим маршрутизатором: состояние передаётся null, как в его документации.
    window.history.replaceState(null, '', url);
  }, [userId, scopes]);
  return null;
}
