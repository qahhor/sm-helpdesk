'use client';

import type { ReactNode } from 'react';
import { clearDeviceData } from '@/ui/drafts';

/**
 * Форма выхода без меню пользователя (шаги после входа). Перед отправкой убирает с устройства черновики и другие
 * записи портала (ASVS 5.0.0, требование 14.3.1), как пункт "Выйти" меню.
 */
export function SignOutForm({ action, className, children }: { action: () => Promise<void>; className?: string; children: ReactNode }) {
  return (
    <form action={action} onSubmit={() => clearDeviceData()} className={className}>
      {children}
    </form>
  );
}
