import { expect, test } from 'vitest';
import { isPublicPath } from '@/security/public-paths';

// Открытая зона (группа маршрутов (public)): ответы не ставят кук, прокси сессию не трогает
// (ТЗ 18.10, правило 4 кеширования публичных страниц; итоговая проверка M1).

test('страницы политики относятся к открытой зоне, остальные нет', () => {
  for (const path of ['/ru/legal/privacy', '/uz/legal/privacy', '/en/legal', '/ru/legal/'])
    expect(isPublicPath(path), path).toBe(true);
  for (const path of ['/ru', '/ru/login', '/ru/settings', '/ru/legalese', '/legal/privacy', '/ru/x/legal/privacy'])
    expect(isPublicPath(path), path).toBe(false);
});
