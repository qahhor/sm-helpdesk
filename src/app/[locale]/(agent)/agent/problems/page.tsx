import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { HDP_ERROR_CODES, PROBLEM_STATUSES, PROBLEM_WRITER_ROLES, type ProblemStatus, problemRef } from '@/modules/hdp/api';
import { listProblems } from '@/modules/hdp/api/problems';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { createProblemAction } from './actions';
import { PROBLEM_STATUS_TONE } from './status-tone';

// Известные проблемы на рабочем месте (ТЗ 7.15, FR-ADM-12, FR-KP-10; план M5c, задача 2), образец "Список": статус,
// модуль, обращений, организаций, последнее появление, поиск по номеру и названию обычной формой GET. Открытые
// сверху. Создают проблему agent_l2, care, admin. Таблица прокручивается вбок внутри карточки (360, 768, 1280).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Search = { status?: string; module?: string; q?: string };

export default async function AgentProblemsPage({ searchParams }: { searchParams: Promise<Search & { status?: string }> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.problems');
  const locale = await getLocale();
  const format = await getFormatter();
  const search = await searchParams;
  const rawStatus = firstParam(search.status) ?? '';
  const error = rawStatus.startsWith('error-') ? rawStatus.slice(6) : null;
  const status = rawStatus === 'active' || (PROBLEM_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as ProblemStatus | 'active') : undefined;
  const moduleId = UUID.test(firstParam(search.module) ?? '') ? firstParam(search.module) : undefined;
  const q = (firstParam(search.q) ?? '').trim().slice(0, 200);
  const rows = await listProblems(staff, { ...(status ? { status } : {}), ...(moduleId ? { moduleId } : {}), ...(q ? { q } : {}) });
  const modules = await listActiveModules(staff.actor, locale);
  const moduleName = new Map(modules.map((m) => [m.moduleId, m.name]));
  const canWrite = (PROBLEM_WRITER_ROLES as readonly string[]).includes(staff.actor.staffRole);

  return (
    <>
      <PageHeader title={s('title')} breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title') }]} breadcrumbsLabel={t('breadcrumbs')} />
      <div className="flex flex-col gap-4">
        {error && <Alert tone="danger">{s(`errors.${(HDP_ERROR_CODES as readonly string[]).includes(error) ? error : 'forbidden'}`, { kinds: '' })}</Alert>}
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label={s('filters.label')}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="problems-status">{s('filters.status')}</Label>
            <Select id="problems-status" name="status" defaultValue={status ?? ''}>
              <option value="">{s('filters.any')}</option>
              <option value="active">{s('filters.active')}</option>
              {PROBLEM_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {s(`statuses.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="problems-module">{s('filters.module')}</Label>
            <Select id="problems-module" name="module" defaultValue={moduleId ?? ''}>
              <option value="">{s('filters.any')}</option>
              {modules.map((m) => (
                <option key={m.moduleId} value={m.moduleId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="problems-q">{s('filters.q')}</Label>
            <Input id="problems-q" name="q" type="search" maxLength={200} defaultValue={q} />
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
            <table className="w-full text-sm" aria-label={s('title')} data-testid="agent-problems">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {(['number', 'title', 'status', 'module', 'tickets', 'orgs', 'lastSeen'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {s(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.problemId} className="border-b border-border align-top last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-3">
                      <Link href={`/agent/problems/${row.number}`} className="text-link underline underline-offset-2">
                        {problemRef(row.number)}
                      </Link>
                    </td>
                    <td className="break-words px-3 py-3">{row.internalTitle}</td>
                    <td className="px-3 py-3">
                      <span className="flex flex-wrap gap-1">
                        <StatusLabel tone={PROBLEM_STATUS_TONE[row.status]}>{s(`statuses.${row.status}`)}</StatusLabel>
                        {row.showToClients && <StatusLabel tone="teal">{s('shown')}</StatusLabel>}
                      </span>
                    </td>
                    <td className="px-3 py-3">{row.moduleId ? (moduleName.get(row.moduleId) ?? '') : ''}</td>
                    <td className="px-3 py-3 tabular-nums">{row.ticketCount}</td>
                    <td className="px-3 py-3 tabular-nums">{row.orgCount}</td>
                    <td className="whitespace-nowrap px-3 py-3">{row.lastSeenOn ? format.dateTime(row.lastSeenOn, { dateStyle: 'medium', timeStyle: 'short' }) : s('info.never')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {canWrite && (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">{s('createTitle')}</h2>
            </CardHeader>
            <CardContent>
              <form action={createProblemAction} className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Label htmlFor="problem-new-title">{s('internalTitle')}</Label>
                  <Input id="problem-new-title" name="internalTitle" required maxLength={200} aria-describedby="problem-new-title-hint" />
                  <p id="problem-new-title-hint" className="text-xs text-muted-foreground">
                    {s('internalTitleHint')}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="problem-new-module">{s('fields.module')}</Label>
                  <Select id="problem-new-module" name="moduleId" defaultValue="">
                    <option value="">{s('fields.noModule')}</option>
                    {modules.map((m) => (
                      <option key={m.moduleId} value={m.moduleId}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button type="submit">{s('create')}</Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
