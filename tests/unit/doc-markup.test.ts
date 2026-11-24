import { expect, test } from 'vitest';
import { arrowHead, blurCell, drawOrder, isMeaningful, nextNumber, rectOf, type Shape, strokeOf } from '@/ui/doc/markup';

// Разметка снимка экрана (UX-W-03; план M5, задача 3): геометрия без браузера.

test('прямоугольник по двум углам в любом порядке и в пределах изображения', () => {
  expect(rectOf({ x: 120, y: 80 }, { x: 20, y: 10 }, { width: 200, height: 100 })).toEqual({ x: 20, y: 10, width: 100, height: 70 });
  expect(rectOf({ x: -50, y: 50 }, { x: 500, y: 300 }, { width: 200, height: 100 })).toEqual({ x: 0, y: 50, width: 200, height: 50 });
});

test('толщина линии растёт с размером снимка, но не тоньше 3 пикселей', () => {
  expect(strokeOf(320)).toBe(3);
  expect(strokeOf(1920)).toBe(6);
});

test('наконечник стрелки симметричен линии и смотрит назад от острия', () => {
  const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);
  expect(left.x).toBeLessThan(100);
  expect(right.x).toBeCloseTo(left.x);
  expect(left.y).toBeCloseTo(-right.y);
});

test('случайный щелчок не становится фигурой, номер ставится щелчком', () => {
  expect(isMeaningful({ kind: 'frame', from: { x: 10, y: 10 }, to: { x: 12, y: 11 } }, 4)).toBe(false);
  expect(isMeaningful({ kind: 'arrow', from: { x: 10, y: 10 }, to: { x: 60, y: 10 } }, 4)).toBe(true);
  expect(isMeaningful({ kind: 'number', at: { x: 1, y: 1 }, value: 1 }, 4)).toBe(true);
});

test('номер шага следующий за самым большим; размытие рисуется первым', () => {
  const shapes: Shape[] = [
    { kind: 'number', at: { x: 1, y: 1 }, value: 1 },
    { kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 9, y: 9 } },
    { kind: 'number', at: { x: 5, y: 5 }, value: 3 },
    { kind: 'blur', from: { x: 0, y: 0 }, to: { x: 50, y: 50 } },
  ];
  expect(nextNumber(shapes)).toBe(4);
  expect(nextNumber([])).toBe(1);
  expect(drawOrder(shapes).map((s) => s.kind)).toEqual(['blur', 'number', 'arrow', 'number']);
});

test('квадрат размытия крупный: текст в области не читается', () => {
  expect(blurCell({ x: 0, y: 0, width: 30, height: 20 })).toBe(8);
  expect(blurCell({ x: 0, y: 0, width: 600, height: 120 })).toBe(20);
});
