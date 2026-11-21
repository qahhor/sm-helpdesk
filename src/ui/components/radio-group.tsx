import { cn } from '@/ui/cn';

export type RadioOption = { value: string; label: string };

/**
 * Выбор одного варианта обычными переключателями: работает с клавиатуры и без скриптов.
 * Область нажатия каждого варианта не меньше 44 px (h-control в зоне клиента).
 */
export function RadioGroup({
  name,
  legend,
  options,
  value,
  defaultValue,
  onChange,
  hint,
  className,
}: {
  name: string;
  legend: string;
  options: readonly RadioOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  hint?: string;
  className?: string;
}) {
  const hintId = hint ? `radio-${name}-hint` : undefined;
  return (
    <fieldset className={cn('flex flex-col gap-1', className)} aria-describedby={hintId}>
      <legend className="mb-1 text-sm font-medium text-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-x-6">
        {options.map((option) => (
          <label key={option.value} className="inline-flex min-h-control items-center gap-3">
            <input
              type="radio"
              name={name}
              value={option.value}
              className="size-5 accent-primary"
              {...(value !== undefined ? { checked: value === option.value, onChange: () => onChange?.(option.value) } : { defaultChecked: defaultValue === option.value })}
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </fieldset>
  );
}
