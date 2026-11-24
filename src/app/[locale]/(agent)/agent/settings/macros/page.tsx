import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaffActor } from '@/modules/hdu/api';
import { listMacros } from '@/modules/hdw/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../sections';
import { moveMacroAction } from './actions';

// "Макросы" (FR-AG-15, UX-A-16, FR-ADM-10; план M8, задача 6): макросы в порядке, в котором их видит сотрудник
// в меню на странице обращения. Новый макрос и правка открываются в редакторе.

const DONE = new Set(['moved', 'deleted']);
const ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found']);

export default async function MacrosSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const m = await getTranslations('agent.settings.macros');
  const r = await getTranslations('agent.settings.rules');
  const { done, error } = await searchParams;
  const macros = await listMacros(staff);
  const actionName = (action: string) => (m.has(`actions.${action}`) ? m(`actions.${action}`) : r.has(`actions.${action}`) ? r(`actions.${action}`) : action);
  return (
    <>
      <PageHeader
        title={m('title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: m('title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          <Link href="/agent/settings/macros/new" className={buttonVariants()}>
            {m('newMacro')}
          </Link>
        }
      />
      <SettingsLayout {...await settingsNav('macros')}>
        {done && DONE.has(done) && <Alert tone="success">{m(`done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && <Alert tone="danger">{m(`errors.${error}`)}</Alert>}
        <p className="text-secondary-foreground">{m('intro')}</p>
        {macros.length === 0 ? (
          <Card>
            <EmptyState title={m('emptyTitle')} text={m('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={m('listLabel')}>
              <thead>
                <tr className="border-b border-border text-start text-muted-foreground">
                  {(['order', 'name', 'actions', 'state', 'controls'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {m(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {macros.map((macro, index) => (
                  <tr key={macro.macroId} data-macro={macro.name} className="border-b border-border align-top last:border-b-0">
                    <td className="px-3 py-3 tabular-nums">{index + 1}</td>
                    <th scope="row" className="px-3 py-3 text-start font-normal">
                      <Link href={`/agent/settings/macros/${macro.macroId}`} className="break-words font-semibold text-link underline-offset-2 hover:underline">
                        {macro.name}
                      </Link>
                    </th>
                    <td className="px-3 py-3">{macro.actions.map((item) => actionName(item.action === 'assign_me' ? 'assign' : item.action)).join(', ')}</td>
                    <td className="px-3 py-3">
                      <span className="flex flex-wrap gap-1">
                        <StatusLabel tone={macro.isEnabled ? 'green' : 'gray'}>{m(macro.isEnabled ? 'states.enabled' : 'states.disabled')}</StatusLabel>
                        {!macro.isValid && <StatusLabel tone="orange">{m('states.invalid')}</StatusLabel>}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-2">
                        {(['up', 'down'] as const).map((direction) => (
                          <form key={direction} action={moveMacroAction}>
                            <input type="hidden" name="macroId" value={macro.macroId} />
                            <input type="hidden" name="direction" value={direction} />
                            <Button
                              type="submit"
                              variant="secondary"
                              size="small"
                              disabled={direction === 'up' ? index === 0 : index === macros.length - 1}
                              aria-label={m(direction === 'up' ? 'moveUpOf' : 'moveDownOf', { name: macro.name })}
                            >
                              {m(direction === 'up' ? 'moveUp' : 'moveDown')}
                            </Button>
                          </form>
                        ))}
                        <Link href={`/agent/settings/macros/${macro.macroId}`} className={buttonVariants({ variant: 'secondary', size: 'small' })} aria-label={m('openOf', { name: macro.name })}>
                          {m('open')}
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </SettingsLayout>
    </>
  );
}
