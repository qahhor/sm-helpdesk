// Разметка снимка экрана (UX-W-03; план M5, задача 3): стрелка, рамка, номер шага, размытие области. Здесь только
// геометрия и порядок рисования без браузера; холст рисует ScreenshotMarkup.tsx. Координаты в пикселях исходного
// изображения: итоговый файл в полном размере, а не в размере окна.

export type Point = { x: number; y: number };
export type MarkupTool = 'arrow' | 'frame' | 'number' | 'blur';
export type Shape =
  | { kind: 'arrow'; from: Point; to: Point }
  | { kind: 'frame'; from: Point; to: Point }
  | { kind: 'blur'; from: Point; to: Point }
  | { kind: 'number'; at: Point; value: number };

export type Rect = { x: number; y: number; width: number; height: number };

/** Прямоугольник по двум углам в любом порядке, обрезанный по изображению. */
export function rectOf(from: Point, to: Point, bounds: { width: number; height: number }): Rect {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const x1 = clamp(Math.min(from.x, to.x), bounds.width);
  const y1 = clamp(Math.min(from.y, to.y), bounds.height);
  const x2 = clamp(Math.max(from.x, to.x), bounds.width);
  const y2 = clamp(Math.max(from.y, to.y), bounds.height);
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(x2 - x1),
    height: Math.round(y2 - y1),
  };
}

/** Толщина линий по ширине изображения: на снимке 1920 пикселей линия 6 пикселей, не тоньше 3. */
export function strokeOf(width: number): number {
  return Math.max(3, Math.round(width / 320));
}

/** Две точки наконечника стрелки: углы 30 градусов от линии, длина в четыре толщины. */
export function arrowHead(from: Point, to: Point, stroke: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = stroke * 4;
  const spread = Math.PI / 6;
  return [
    {
      x: to.x - length * Math.cos(angle - spread),
      y: to.y - length * Math.sin(angle - spread),
    },
    {
      x: to.x - length * Math.cos(angle + spread),
      y: to.y - length * Math.sin(angle + spread),
    },
  ];
}

/** Слишком маленькая фигура (случайный щелчок) не сохраняется. Номер ставится щелчком и сохраняется всегда. */
export function isMeaningful(shape: Shape, stroke: number): boolean {
  if (shape.kind === 'number') return true;
  return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= stroke * 2;
}

/** Следующий номер шага: на единицу больше самого большого на снимке. */
export function nextNumber(shapes: readonly Shape[]): number {
  return shapes.reduce((max, shape) => (shape.kind === 'number' ? Math.max(max, shape.value) : max), 0) + 1;
}

/**
 * Размытие рисуется до остальных фигур: стрелка и номер поверх размытой области остаются чёткими. Размытие
 * необратимо: область заменяется крупными квадратами, исходные пиксели в файл не попадают.
 */
export function drawOrder(shapes: readonly Shape[]): Shape[] {
  return [...shapes.filter((s) => s.kind === 'blur'), ...shapes.filter((s) => s.kind !== 'blur')];
}

/** Размер квадрата размытия: текст в области не читается и на крупном снимке. */
export function blurCell(rect: Rect): number {
  return Math.max(8, Math.round(Math.min(rect.width, rect.height) / 6));
}

/** Типы снимков, которые принимает загрузка решения (план M5, решение 13). */
export const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

/** Файл снимка в изображение для холста. Не изображение или не открылось: null. Только в браузере. */
export function loadImageFile(file: Blob): Promise<HTMLImageElement | null> {
  if (!IMAGE_TYPES.includes(file.type)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
