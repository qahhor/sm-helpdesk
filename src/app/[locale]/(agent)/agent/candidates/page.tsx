import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { listCandidates } from '@/modules/hda/api/candidate-actions';
import { CANDIDATE_STATUSES, type CandidateStatus } from '@/modules/hda/api/constants';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';

// Очередь кандидатов в решения (ТЗ 8.12 "Кандидаты", FR-CAND-04; план M5c, задача 10): по умолчанию новые, больше
// источников и организаций сверху, фильтр модуля и поиск обычной формой GET. Видят роли с правом черновика решения.
// Кандидат не в поиске решений и не у клиентов. Таблица прокручивается вбок внутри карточки (360, 768, 1280).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AgentCandidatesPage({ searchParams }: { searchParams: Promise<{ status?: string; module?: string; q?: string }> }) {
  const staff = await requireStaffActor({ roles: ['agent_l1', 'agent_l2', 'care', 'admin'] });
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.candidates');
  const locale = await getLocale();
  const format = await getFormatter();
  const search = await searchParams;
  const rawStatus = firstParam(search.status) ?? '';
  const status = (CANDIDATE_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as CandidateStatus) : 'new';
  const moduleId = UUID.test(firstParam(search.module) ?? '') ? firstParam(search.module) : undefined;
  const q = (firstParam(search.q) ?? '').trim().slice(0, 200);
  const rows = await listCandidates(staff, { status, ...(moduleId ? { moduleId } : {}), ...(q ? { q } : {}) });
  const modules = await listActiveModules(staff.actor, locale);
  const moduleName = new Map(modules.map((m) => [m.moduleId, m.name]));
  return (
    <>
      <PageHeader title={s('title')} breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title') }]} breadcrumbsLabel={t('breadcrumbs')} />
      <div className="flex flex-col gap-4">
        <p className="text-secondary-foreground">{s('intro')}</p>
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label={s('filters.label')}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="candidates-status">{s('filters.status')}</Label>
            <Select id="candidates-status" name="status" defaultValue={status}>
              {CANDIDATE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {s(`statuses.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="candidates-module">{s('filters.module')}</Label>
            <Select id="candidates-module" name="module" defaultValue={moduleId ?? ''}>
              <option value="">{s('filters.any')}</option>
              {modules.map((m) => (
                <option key={m.moduleId} value={m.moduleId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="candidates-q">{s('filters.q')}</Label>
            <Input id="candidates-q" name="q" type="search" maxLength={200} defaultValue={q} />
          </div>
          <Button type="submit" variant="secondary">
            {s('filters.apply')}
          </Button>
        </form>
        {rows.length === 0 ? (
          <Card>
            <EmptyState title={s('empty')} text={s('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={s('title')} data-testid="agent-candidates">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {(['title', 'module', 'sources', 'orgs', 'created'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {s(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.candidateId} className="border-b border-border align-top last:border-b-0">
                    <td className="break-words px-3 py-3">
                      <Link href={`/agent/candidates/${row.candidateId}`} className="text-link underline underline-offset-2">
                        {row.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3">{row.moduleId ? (moduleName.get(row.moduleId) ?? '') : ''}</td>
                    <td className="px-3 py-3 tabular-nums">{row.sourceCount}</td>
                    <td className="px-3 py-3 tabular-nums">{row.orgCount}</td>
                    <td className="whitespace-nowrap px-3 py-3">{format.dateTime(row.createdOn, { dateStyle: 'medium' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}
