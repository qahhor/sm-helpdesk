'use client';

import { type ReactNode, useSyncExternalStore } from 'react';

// Ниже 1024 px рабочее место переходит в упрощённый вид (слой планшета Smartup Web).
// Признак data-layout="compact" на корне читают экраны, которым нужна другая раскладка.
const COMPACT = '(max-width: 1023px)';

function subscribe(onChange: () => void) {
  const media = window.matchMedia(COMPACT);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function AgentRoot({ children }: { children: ReactNode }) {
  const compact = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(COMPACT).matches,
    () => false,
  );
  return (
    <div
      data-zone="agent"
      data-layout={compact ? 'compact' : undefined}
      className="flex min-h-dvh flex-col bg-background text-base text-foreground"
    >
      {children}
    </div>
  );
}
