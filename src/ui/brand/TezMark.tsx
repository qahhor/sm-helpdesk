import { cn } from '@/ui/cn';
import { pickTezAsset, TEZ_ASSETS, TEZ_POSES, type TezPose } from './tez-assets';

// Размеры Теза в интерфейсе и охранное поле для каждого (1/6 размера, tezClearSpace).
// Список закрытый: поле задаётся классом, а не вычисленным стилем.
const SIZES = {
  24: 'p-1',
  32: 'p-1.5',
  40: 'p-1.75',
  64: 'p-2.75',
  96: 'p-4',
  120: 'p-5',
} as const;

export type TezSize = keyof typeof SIZES;

/**
 * Тез, герой бренда и лицо AI-помощника. Файл выбирается по размеру и фону.
 * Параметров поворота, отражения и цвета нет: гид бренда это запрещает.
 * На экране одновременно один крупный Тез (UX-B-04).
 *
 * onDark не задан: фон следует за темой, файл подбирается сам.
 * onDark задан: фон постоянный, например тёмная шапка в обеих темах.
 * pose: поза из пакета бренда под смысл экрана (TEZ_POSES); у позы один файл на оба фона.
 */
export function TezMark({ size, onDark, pose, className }: { size: TezSize; onDark?: boolean; pose?: TezPose; className?: string }) {
  if (pose)
    return (
      <span data-tez={size > 40 ? 'main' : 'icon'} data-pose={pose} className={cn('inline-flex shrink-0', SIZES[size], className)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- см. ниже: next/image нарушает CSP */}
        <img src={`/brand/tez/${TEZ_POSES[pose]}`} width={size} height={size} alt="" aria-hidden />
      </span>
    );
  const image = (dark: boolean, visibility?: string) => {
    const asset = pickTezAsset(size, dark);
    if (!asset) return null;
    return (
      // Обычный img: next/image добавляет встроенный стиль, который запрещает политика CSP,
      // а оптимизатор изображений в портале выключен (docs/decisions/0002).
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/brand/tez/${TEZ_ASSETS[asset]}`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        className={visibility}
      />
    );
  };
  return (
    <span data-tez={size > 40 ? 'main' : 'icon'} className={cn('inline-flex shrink-0', SIZES[size], className)}>
      {onDark === undefined ? (
        <>
          {image(false, 'dark:hidden')}
          {image(true, 'hidden dark:block')}
        </>
      ) : (
        image(onDark)
      )}
    </span>
  );
}
