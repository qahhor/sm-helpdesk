// Тема оформления: светлая, тёмная или как в системе. Выбор хранится в куке на год.

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'system';
export const THEME_COOKIE = 'hub_theme';
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

/**
 * Скрипт, который ставит класс dark на корневой элемент до первой отрисовки.
 * Без него страница на мгновение показывалась бы в светлой теме.
 */
export const THEME_SCRIPT =
  '(function(){try{' +
  `var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark|system)/);` +
  `var t=m?m[1]:'${DEFAULT_THEME}';` +
  "var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);" +
  "document.documentElement.classList.toggle('dark',d);" +
  '}catch(e){}})();';
