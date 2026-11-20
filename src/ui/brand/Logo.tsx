import Image from 'next/image';
import { cn } from '@/ui/cn';
import { LOGO_ASSETS } from './tez-assets';

/**
 * Логотип Smartup: официальный файл для светлого или тёмного фона, без подложки, рамки и тени.
 * Название продукта "Hub" пишется текстом рядом: отдельного логотипа у портала нет (ТЗ 8.13).
 *
 * onDark не задан: фон следует за темой. onDark задан: фон постоянный (тёмная шапка).
 */
export function Logo({ onDark, withProductName = false, className }: { onDark?: boolean; withProductName?: boolean; className?: string }) {
  const image = (dark: boolean, visibility?: string) => {
    const asset = dark ? LOGO_ASSETS.onDark : LOGO_ASSETS.onLight;
    return (
      <Image
        src={`/brand/logo/${asset.file}`}
        width={asset.width}
        height={asset.height}
        alt="Smartup"
        className={cn('h-6 w-auto', visibility)}
      />
    );
  };
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {onDark === undefined ? (
        <>
          {image(false, 'dark:hidden')}
          {image(true, 'hidden dark:block')}
        </>
      ) : (
        image(onDark)
      )}
      {withProductName && <span className="text-lg font-semibold">Hub</span>}
    </span>
  );
}
