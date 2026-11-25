'use client';

import { useEffect } from 'react';
import { captureWidgetFragment } from './handoff';

// Страницы входа и выбора организации на пути режима B виджета (план M6, задача 8): фрагмент #widget=1&hints=...
// переносится в sessionStorage вкладки и убирается из адреса сразу. Вход через Smartup уводит вкладку на другой сайт,
// и без этого подсказки потерялись бы. На сервер фрагмент не уходит.
export function WidgetFragmentCapture() {
  useEffect(() => captureWidgetFragment(), []);
  return null;
}
