'use client';

import { cn } from '@/ui/cn';

// Список шаблонов под полем ответа (FR-AG-06, UX-A-05): открывается знаком "/", фильтруется набранным кодом,
// стрелки выбирают, Enter вставляет, Esc закрывает. Клавиши обрабатывает поле ответа, список только показывает.

export type PickerTemplate = { shortcut: string; title: string; text: string; fallback: boolean; isEnabled: true };

export function TemplatePicker({
  id,
  items,
  active,
  label,
  empty,
  onPick,
}: {
  id: string;
  items: PickerTemplate[];
  active: number;
  label: string;
  empty: string;
  onPick: (template: PickerTemplate) => void;
}) {
  return (
    <div className="rounded-control border border-border bg-card p-1">
      {items.length === 0 ? (
        <p className="px-2 py-1 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul id={id} role="listbox" aria-label={label} className="flex max-h-64 flex-col overflow-y-auto">
          {items.map((template, index) => (
            <li
              key={template.shortcut}
              id={`${id}-${template.shortcut}`}
              role="option"
              aria-selected={index === active}
              // До потери фокуса полем: иначе поле закроет список раньше нажатия.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(template);
              }}
              className={cn('flex cursor-pointer flex-col rounded-control px-2 py-1 text-sm', index === active && 'bg-accent')}
            >
              <span>
                <code className="font-semibold">/{template.shortcut}</code> {template.title}
              </span>
              <span className="truncate text-xs text-muted-foreground">{template.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
