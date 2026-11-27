import { getLocale, getTranslations } from 'next-intl/server';
import { firstParam } from '@/lib/search-params';
import { listModuleNotes } from '@/modules/hda/api/code-knowledge';
import { CODE_READER_ROLES } from '@/modules/hda/api/constants';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { approveModuleAction, rejectModuleAction } from '../actions';
import { CodeTabs } from '../CodeTabs';
import { CODE_STATUS_TONE } from '../status-tone';

// Карта модулей и экранов из сканирования (ТЗ FR-CODE-13, 8.12; план M8c, задача 4, решение 14): чем заметка
// отличается от справочника модулей портала. Применить к справочнику или отклонить может только администратор.

export default async function CodeModulesPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: [...CODE_READER_ROLES] });
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.codeKnowledge');
  const locale = await getLocale();
  const search = await searchParams;
  const notes = await listModuleNotes(staff);
  const isAdmin = staff.actor.staffRole === 'admin';
  const done = firstParam(search.done);
  const error = firstParam(search.error);
  const nameOf = (name: Record<string, string>) => name[locale] ?? name.ru ?? '';
  return (
    <>
      <PageHeader
        title={s('tabs.modules')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/code-knowledge' }, { label: s('tabs.modules') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex flex-col gap-4">
        <CodeTabs current="modules" />
        <p className="text-secondary-foreground">{s('modules.intro')}</p>
        {done === 'approved' && <Alert tone="success">{s('modules.done')}</Alert>}
        {done === 'rejected' && <Alert tone="success">{s('modules.doneRejected')}</Alert>}
        {error && <Alert tone="danger">{s.has(`errors.${error}`) ? s(`errors.${error}`) : s('errors.not_found')}</Alert>}
        {notes.length === 0 ? (
          <Card>
            <EmptyState title={s('modules.empty')} text={s('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={s('tabs.modules')} data-testid="code-modules">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {(['module', 'screens', 'directory', 'status'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {s(`modules.columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {notes.map((note) => (
                  <tr key={note.moduleCode} className="border-b border-border align-top last:border-b-0" data-code-module={note.moduleCode}>
                    <td className="px-3 py-3">
                      <span className="font-semibold">{nameOf(note.name)}</span> <span className="break-all text-secondary-foreground">{note.moduleCode}</span>
                      {note.summary && <p className="break-words text-secondary-foreground">{note.summary}</p>}
                    </td>
                    <td className="break-words px-3 py-3">{note.screens.map((screen) => nameOf(screen.name) || screen.code).join(', ')}</td>
                    <td className="px-3 py-3">{s(`modules.directory.${note.directory}`)}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col items-start gap-2">
                        <StatusLabel tone={CODE_STATUS_TONE[note.status]}>{s(`statuses.${note.status}`)}</StatusLabel>
                        {isAdmin && note.directory !== 'same' && (
                          <form action={approveModuleAction}>
                            <input type="hidden" name="code" value={note.moduleCode} />
                            <Button type="submit" size="small">
                              {s('modules.approve')}
                            </Button>
                          </form>
                        )}
                        {isAdmin && note.status === 'draft' && (
                          <form action={rejectModuleAction}>
                            <input type="hidden" name="code" value={note.moduleCode} />
                            <Button type="submit" size="small" variant="secondary">
                              {s('modules.reject')}
                            </Button>
                          </form>
                        )}
                      </div>
                    </td>
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
