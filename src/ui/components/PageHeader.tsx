import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';

export type Breadcrumb = { label: string; href?: string };

/**
 * Заголовок страницы рабочего места: путь от корня раздела, заголовок и одно основное действие (UX-S-07).
 */
export function PageHeader({
  title,
  breadcrumbs,
  breadcrumbsLabel,
  action,
}: {
  title: string;
  breadcrumbs: Breadcrumb[];
  breadcrumbsLabel: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <nav aria-label={breadcrumbsLabel}>
        <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {breadcrumbs.map((crumb, index) => (
            <li key={`${crumb.label}-${index}`} className="inline-flex items-center gap-1">
              {index > 0 && <ChevronRight className="size-3 rtl:rotate-180" aria-hidden />}
              {crumb.href ? (
                <Link href={crumb.href} className="text-link underline-offset-2 hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}>{crumb.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{title}</h1>
        {action}
      </div>
    </div>
  );
}
