'use client';

import { useState, useSyncExternalStore } from 'react';

const noop = () => () => {};

/**
 * Переключатель "Фильтры" на телефоне (проверка интерфейса, U15; второй проход, F12). Раскрытие по-прежнему делает
 * флажок и CSS, без скриптов форма работает. Со скриптами флажок объявляет состояние раскрытия и блок, которым
 * управляет: без этого он читался как "Фильтры, флажок, не отмечен". До гидратации aria-expanded не ставится:
 * без скриптов его некому обновлять.
 */
export function FiltersToggle({ id, controls, defaultOpen }: { id: string; controls: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return (
    <input
      id={id}
      type="checkbox"
      className="peer sr-only tablet:hidden"
      defaultChecked={defaultOpen}
      aria-controls={controls}
      aria-expanded={hydrated ? open : undefined}
      onChange={(event) => setOpen(event.target.checked)}
    />
  );
}
