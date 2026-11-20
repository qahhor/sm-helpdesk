import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Собирает классы и убирает противоречащие: cn('p-2', wide && 'p-4'). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
