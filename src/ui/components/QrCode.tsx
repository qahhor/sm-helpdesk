import { cn } from '@/ui/cn';

/** Отступ вокруг рисунка в модулях: без него часть сканеров код не читает. */
const QUIET_ZONE = 4;

/**
 * QR-код из готовой матрицы. Матрицу строит сервер: библиотека кодирования в браузер не попадает.
 * Рисунок всегда тёмный на светлом, в обеих темах: так его читают сканеры.
 */
export function QrCode({ matrix, label, className }: { matrix: boolean[][]; label: string; className?: string }) {
  const size = matrix.length + QUIET_ZONE * 2;
  let path = '';
  matrix.forEach((line, y) => {
    line.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn('size-48 rounded-control bg-qr-background', className)}
    >
      <path d={path} className="fill-qr-foreground" />
    </svg>
  );
}
