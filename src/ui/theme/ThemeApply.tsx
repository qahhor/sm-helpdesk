'use client';

import { useEffect } from 'react';
import { applyTheme, readTheme } from './theme-client';

/**
 * Тема для страниц, которые браузер собирает сам (план M9, задача 8, решение 23): страницу "не найдено" Next.js отдаёт
 * пустым документом ошибки и рисует в браузере, а встроенный скрипт темы в такой разметке не выполняется. Тот же выбор
 * из куки применяется после сборки. На обычной странице скрипт уже применил его, повтор ничего не меняет.
 */
export function ThemeApply() {
  useEffect(() => applyTheme(readTheme()), []);
  return null;
}
