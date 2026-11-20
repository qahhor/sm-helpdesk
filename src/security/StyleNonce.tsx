'use client';

import { setNonce } from 'get-nonce';

// Меню и нижний лист (Radix) при открытии блокируют прокрутку страницы и для этого
// добавляют на страницу блок стилей. Политика CSP пропускает его только с одноразовым кодом запроса.
// Код берётся у уже подписанного скрипта страницы: в разметке и в данных страницы он не дублируется.
if (typeof document !== 'undefined') {
  const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
  if (nonce) setNonce(nonce);
}

/** Подключает передачу одноразового кода библиотекам, которые добавляют стили во время работы. */
export function StyleNonce() {
  return null;
}
