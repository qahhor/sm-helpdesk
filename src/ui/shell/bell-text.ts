/** Больше этого числа счётчик показывает "99+". */
const MAX_SHOWN = 99;

/**
 * Подпись колокольчика и число на значке (FR-NT-03). Подпись для диктора содержит ровно то число, что видно на значке
 * (WCAG 2.5.3, правило axe label-content-name-mismatch): при 148 непрочитанных и там, и там "99+".
 */
export function bellText(count: number, labels: { none: string; some: string }): { label: string; badge: string | null } {
  if (count <= 0) return { label: labels.none, badge: null };
  const badge = count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(count);
  return { label: labels.some.replace('{count}', badge), badge };
}
