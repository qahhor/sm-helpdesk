import { getFormatter, getTranslations } from 'next-intl/server';
import { isHdtError, listTickets, TICKET_STATUSES, TICKET_TYPES } from '@/modules/hdt/api';
import { requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { TicketList } from './TicketList';
import { Select } from '@/ui/components/select';

// Список обращений клиента (FR-TK-06): организации или мои, статус, тип, поиск по номеру и тексту, по 20 на страницу.
// Фильтры обычной формой GET: работают без скриптов, адрес со списком можно сохранить.

type Search = { scope?: string; status?: string; type?: string; q?: string; cursor?: string };

export default async function ClientTicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const client = await requireClientActor();
  const t = await getTranslations('client');
  const format = await getFormatter();
  const search = await searchParams;
  const filters = { scope: search.scope === 'mine' ? 'mine' : 'org', status: search.status, type: search.type, q: search.q, cursor: search.cursor };
  let page: Awaited<ReturnType<typeof listTickets>> = { items: [], nextCursor: null, searchTooShort: false };
  try {
    page = await listTickets(client, filters);
  } catch (error) {
    // Испорченный адрес (чужой статус, курсор): пустой список, как при отсутствии совпадений.
    if (!isHdtError(error)) throw error;
  }
  const filtered = Boolean(search.status || search.type || search.q || search.scope === 'mine');
  const next = page.nextCursor ? `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), cursor: page.nextCursor })}` : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('nav.tickets')}</h1>
        <Button asChild>
          <Link href="/tickets/new">{t('tickets.list.new')}</Link>
        </Button>
      </div>
      <form method="get" className="grid grid-cols-1 gap-3 tablet:grid-cols-4 tablet:items-end">
        <div className="flex flex-col gap-1">
          <Label htmlFor="filter-scope">{t('tickets.list.scope')}</Label>
          <Select id="filter-scope" name="scope" defaultValue={filters.scope}>
            <option value="org">{t('tickets.list.scopes.org')}</option>
            <option value="mine">{t('tickets.list.scopes.mine')}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="filter-status">{t('tickets.list.status')}</Label>
          <Select id="filter-status" name="status" defaultValue={search.status ?? ''}>
            <option value="">{t('tickets.list.all')}</option>
            {TICKET_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`tickets.statuses.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="filter-type">{t('tickets.list.type')}</Label>
          <Select id="filter-type" name="type" defaultValue={search.type ?? ''}>
            <option value="">{t('tickets.list.all')}</option>
            {TICKET_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`tickets.types.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="filter-q">{t('tickets.list.search')}</Label>
          <div className="flex gap-2">
            <Input id="filter-q" name="q" type="search" maxLength={100} defaultValue={search.q ?? ''} />
            <Button type="submit" variant="secondary">
              {t('tickets.list.find')}
            </Button>
          </div>
        </div>
      </form>
      <Card>
        {page.items.length === 0 ? (
          filtered ? (
            <p className="p-4 text-muted-foreground">{t(page.searchTooShort ? 'tickets.list.tooShort' : 'tickets.list.nothing')}</p>
          ) : (
            <EmptyState withTez title={t('tickets.emptyTitle')} text={t('tickets.emptyText')} />
          )
        ) : (
          <TicketList
            items={page.items.map((item) => ({
              number: item.number,
              title: item.title,
              status: item.status,
              statusLabel: t(`tickets.statuses.${item.status}`),
              when: format.relativeTime(item.modifiedOn),
              privateLabel: item.visibility === 'private' ? t('tickets.list.private') : null,
            }))}
          />
        )}
      </Card>
      {next && (
        <Button asChild variant="secondary" className="self-center">
          <Link href={`/tickets${next}`}>{t('tickets.list.more')}</Link>
        </Button>
      )}
    </>
  );
}
