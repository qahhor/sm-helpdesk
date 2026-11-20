import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { isHduError, requireStaffActor, searchOrganizations } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const head = 'px-3 py-2 text-start text-xs font-medium text-secondary-foreground';
const cell = 'px-3';

// Организации клиентов в рабочем месте (FR-ID-13): поиск по названию, ИНН и идентификатору компании.
// Видят все сотрудники-люди. По 50 строк на странице.
export default async function OrganizationsPage({ searchParams }: PageProps<'/[locale]/agent/organizations'>) {
  const staff = await requireStaffActor();
  const params = await searchParams;
  const query = first(params.q) ?? '';
  const page = Number(first(params.page) ?? '1');
  const t = await getTranslations('agent');

  let result: Awaited<ReturnType<typeof searchOrganizations>> | null = null;
  try {
    result = await searchOrganizations(staff, { query, page: Number.isFinite(page) ? page : 1 });
  } catch (error) {
    if (!isHduError(error) || error.code !== 'invalid_input') throw error;
  }
  const pageHref = (target: number) => `/agent/organizations?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(target) })}`;

  return (
    <>
      <PageHeader
        title={t('orgs.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('orgs.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <form method="get" role="search" className="flex items-end gap-2">
        <div className="flex max-w-md flex-1 flex-col gap-1">
          <Label htmlFor="org-search">{t('orgs.search')}</Label>
          <Input id="org-search" name="q" defaultValue={query} maxLength={100} placeholder={t('orgs.searchHint')} />
        </div>
        <Button type="submit" variant="secondary">
          {t('orgs.find')}
        </Button>
      </form>

      {!result ? (
        <Alert tone="danger">{t('orgs.invalid')}</Alert>
      ) : result.items.length === 0 ? (
        <Card>
          <EmptyState title={t('orgs.emptyTitle')} text={t('orgs.emptyText')} />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={head}>{t('orgs.name')}</th>
                <th scope="col" className={head}>{t('orgs.inn')}</th>
                <th scope="col" className={head}>{t('orgs.server')}</th>
                <th scope="col" className={head}>{t('orgs.category')}</th>
                <th scope="col" className={head}>{t('orgs.members')}</th>
                <th scope="col" className={head}>{t('orgs.state')}</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((org) => (
                <tr key={org.orgId} className="h-row border-b border-border last:border-b-0">
                  <td className={cell}>
                    <Link href={`/agent/organizations/${org.orgId}`} className="font-medium text-link underline-offset-2 hover:underline">
                      {org.name}
                    </Link>
                  </td>
                  <td className={cell}>{org.inn ?? t('orgs.none')}</td>
                  <td className={cell}>{org.serverName}</td>
                  <td className={cell}>{org.category ?? t('orgs.none')}</td>
                  <td className={cell}>{org.memberCount}</td>
                  <td className={cell}>{t(`orgs.states.${org.state}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {result && (page > 1 || result.hasMore) && (
        <nav aria-label={t('orgs.pages')} className="flex gap-2">
          {page > 1 && (
            <Link href={pageHref(page - 1)} className={buttonVariants({ variant: 'secondary', size: 'small' })}>
              {t('orgs.prev')}
            </Link>
          )}
          {result.hasMore && (
            <Link href={pageHref(page + 1)} className={buttonVariants({ variant: 'secondary', size: 'small' })}>
              {t('orgs.next')}
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
