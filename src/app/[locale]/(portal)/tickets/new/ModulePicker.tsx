'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import type { RadioOption } from '@/ui/components/radio-group';
import { browserDrafts } from '@/ui/drafts';
import { loadRecent, pushRecent, recentKey } from '@/ui/recent';

// Поле "Модуль" (решение 14 плана M2): поиск по названию, когда модулей много, и недавние значения
// этого устройства сверху списка. Обычный список выбора: работает с клавиатуры и программами экранного доступа.

export type ModulePickerLabels = { module: string; none: string; search: string; recent: string; all: string };

/** С какого числа модулей показывается поиск. */
const SEARCH_FROM = 8;
const noop = () => () => {};
const select = 'h-field w-full rounded-control border border-input bg-card px-3 text-base text-foreground';

export function ModulePicker({
  userId,
  modules,
  value,
  onChange,
  labels,
}: {
  userId: string;
  modules: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  labels: ModulePickerLabels;
}) {
  const key = recentKey(userId, 'module');
  // Недавние читаются после гидратации: на сервере их нет.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const recentIds = useMemo(() => (hydrated ? loadRecent(browserDrafts(), key) : []), [hydrated, key]);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  // Выбранный модуль остаётся в списке и при поиске: иначе выбор пропал бы молча.
  const shown = modules.filter((m) => m.value === value || needle === '' || m.label.toLowerCase().includes(needle));
  const recent = recentIds.map((id) => shown.find((m) => m.value === id)).filter((m): m is RadioOption => m !== undefined);
  const rest = shown.filter((m) => !recent.includes(m));
  const option = (m: RadioOption) => (
    <option key={m.value} value={m.value}>
      {m.label}
    </option>
  );

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="field-module">{labels.module}</Label>
      {modules.length > SEARCH_FROM && (
        <Input type="search" aria-label={labels.search} placeholder={labels.search} value={query} onChange={(event) => setQuery(event.target.value)} />
      )}
      <select
        id="field-module"
        name="moduleId"
        className={select}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          pushRecent(browserDrafts(), key, event.target.value);
        }}
      >
        <option value="">{labels.none}</option>
        {recent.length > 0 ? (
          <>
            <optgroup label={labels.recent}>{recent.map(option)}</optgroup>
            <optgroup label={labels.all}>{rest.map(option)}</optgroup>
          </>
        ) : (
          rest.map(option)
        )}
      </select>
    </div>
  );
}
