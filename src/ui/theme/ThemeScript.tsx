import { THEME_SCRIPT } from './theme';

/**
 * Встроенный скрипт темы для <head>. Единственное место в портале, где разметка вставляется строкой:
 * текст скрипта постоянный и не содержит данных пользователя. nonce нужен политике CSP.
 */
export function ThemeScript({ nonce }: { nonce?: string }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
