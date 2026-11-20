import type { ComponentProps } from 'react';
import { cn } from '@/ui/cn';
import { Input } from './input';
import { Label } from './label';

type FormFieldProps = Omit<ComponentProps<'input'>, 'id'> & {
  /** Имя поля формы. Из него же строятся идентификаторы подписи и подсказки. */
  name: string;
  label: string;
  hint?: string;
  error?: string;
};

/**
 * Поле формы: подпись, поле ввода, подсказка и сообщение об ошибке.
 * Подсказка и ошибка связаны с полем для программ экранного доступа.
 */
export function FormField({ name, label, hint, error, className, ...props }: FormFieldProps) {
  const id = `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        {...props}
      />
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive-on-bg">
          {error}
        </p>
      )}
    </div>
  );
}
