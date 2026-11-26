import { DEFAULT_THEME, isTheme, type Theme, THEME_COOKIE, THEME_COOKIE_MAX_AGE, themeCookieName } from './theme';

// Работа с темой в браузере: чтение выбора из куки, применение, оповещение компонентов.

const CHANGE_EVENT = 'hub-theme-change';
export const SYSTEM_DARK = '(prefers-color-scheme: dark)';

export function readTheme(): Theme {
  // Кука на https с приставкой __Host-, на http без неё: читается любая.
  const value = new RegExp(`(?:^|; )(?:__Host-)?${THEME_COOKIE}=([a-z]+)`).exec(document.cookie)?.[1] ?? '';
  return isTheme(value) ? value : DEFAULT_THEME;
}

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia(SYSTEM_DARK).matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Запоминает выбор на год и применяет его сразу. */
export function chooseTheme(theme: Theme): void {
  const https = window.location.protocol === 'https:';
  document.cookie = `${themeCookieName(https)}=${theme}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax${https ? '; secure' : ''}`;
  applyTheme(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeTheme(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}
