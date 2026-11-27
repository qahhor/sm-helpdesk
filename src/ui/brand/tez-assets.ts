// Файлы Теза и логотипа из пакета бренда (docs/brand). Копии для веба лежат в public/brand.
// Правила взяты из гида бренда (docs/brand/BRAND-GUIDE.md) и раздела 8.13 ТЗ.
// Свои варианты не рисуются: Тез не перекрашивается, не зеркалится и не поворачивается.

export const TEZ_ASSETS = {
  icon: 'tez-icon.svg',
  iconOnDark: 'tez-icon-on-dark.svg',
  main: 'tez-main.svg',
  mainOnDark: 'tez-main-on-dark.svg',
} as const;

export type TezAsset = keyof typeof TEZ_ASSETS;

/**
 * Позы Теза под смысл (гид бренда, раздел 8.13 ТЗ). Одна поза на оба фона: в пакете бренда у позы один файл.
 * virazh: состояние "Внимание" (ждём ответа клиента, известная проблема по его модулю; план M5c, задача 4).
 */
export const TEZ_POSES = { virazh: 'pose-virazh.svg' } as const;
export type TezPose = keyof typeof TEZ_POSES;

/** Меньше этого размера Тез не ставится. */
export const TEZ_MIN_SIZE = 16;
/** До этого размера включительно берётся значок, выше основной Тез с перьями. */
export const TEZ_ICON_MAX_SIZE = 40;

/** Какой файл Теза брать для размера в px и фона. null: Тез такого размера не ставится. */
export function pickTezAsset(size: number, onDark: boolean): TezAsset | null {
  if (size < TEZ_MIN_SIZE) return null;
  if (size <= TEZ_ICON_MAX_SIZE) return onDark ? 'iconOnDark' : 'icon';
  return onDark ? 'mainOnDark' : 'main';
}

/** Охранное поле: 1/6 размера Теза со всех сторон, без текста и значков. */
export function tezClearSpace(size: number): number {
  return Math.ceil(size / 6);
}

/** Логотип: только официальные файлы. Размеры в px нужны, чтобы страница не прыгала при загрузке. */
export const LOGO_ASSETS = {
  onLight: { file: 'smartup-logo-light-bg.png', width: 1428, height: 313 },
  onDark: { file: 'smartup-logo-dark-bg.png', width: 1085, height: 313 },
} as const;
