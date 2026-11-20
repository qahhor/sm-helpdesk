/** Витрина компонентов (/dev/ui) открыта только при HUB_SHOWCASE=1. Иначе страница отвечает 404. */
export function showcaseEnabled(e: { HUB_SHOWCASE: '0' | '1' }): boolean {
  return e.HUB_SHOWCASE === '1';
}
