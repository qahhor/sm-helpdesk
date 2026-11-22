'use client';

import { useEffect, useRef, useState } from 'react';
import type { PresenceEntry } from '@/modules/hdt/api';
import { presenceAction } from './actions';

// Кто ещё открыл обращение и кто печатает (FR-AG-12, решение 10): отметка раз в 10 секунд без постоянного
// соединения. Поле ответа сообщает о вводе событием TYPING_EVENT, отметка "печатает" держится 10 секунд.

export const TYPING_EVENT = 'hub:agent-typing';
const TOUCH_MS = 10_000;

export type PresenceLabels = { viewing: string; typing: string };

export function PresenceBar({ number, labels }: { number: number; labels: PresenceLabels }) {
  const [people, setPeople] = useState<PresenceEntry[]>([]);
  const typedAt = useRef(0);

  useEffect(() => {
    let alive = true;
    const touch = () => {
      if (document.visibilityState === 'hidden') return;
      const mode = Date.now() - typedAt.current < TOUCH_MS ? 'typing' : 'viewing';
      presenceAction({ number, mode })
        .then((list) => alive && setPeople(list))
        .catch(() => undefined);
    };
    const onTyping = () => {
      const first = Date.now() - typedAt.current >= TOUCH_MS;
      typedAt.current = Date.now();
      if (first) touch();
    };
    touch();
    const timer = window.setInterval(touch, TOUCH_MS);
    window.addEventListener(TYPING_EVENT, onTyping);
    document.addEventListener('visibilitychange', touch);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(TYPING_EVENT, onTyping);
      document.removeEventListener('visibilitychange', touch);
    };
  }, [number]);

  return (
    <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite" data-presence={people.length}>
      {people.map((person) => (person.mode === 'typing' ? labels.typing : labels.viewing).replace('{name}', person.name)).join(' · ')}
    </p>
  );
}
