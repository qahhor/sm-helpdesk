import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { requireStaffActor } from '@/modules/hdu/api';
import { listRules } from '@/modules/hdw/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../sections';
import { moveRuleAction, setRuleEnabledAction } from './actions';

// "Правила автоматизации" (FR-AUTO-01, 06, FR-ADM-10; план M8, задача 4): правила по порядку применения, включение,
// порядок кнопками "выше" и "ниже". Новое правило и правка открываются в редакторе.

const DONE = new Set(['enabled', 'disabled', 'moved', 'deleted']);
const ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found', 'builtin_rule']);

export default async function RulesSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const r = await getTranslations('agent.settings.rules');
  const { done, error } = await searchParams;
  const rules = await listRules(staff);
  const nav = await settingsNav('rules');
  return (
    <>
      <PageHeader
        title={r('title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: r('title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          <Link href="/agent/settings/rules/new" className={buttonVariants()}>
            {r('newRule')}
          </Link>
        }
      />
      <SettingsLayout {...nav}>
        {done && DONE.has(done) && <Alert tone="success">{r(`done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && <Alert tone="danger">{r(`errors.${error}`)}</Alert>}
        <p className="text-secondary-foreground">{r('intro')}</p>
        {rules.length === 0 ? (
          <Card>
            <EmptyState title={r('emptyTitle')} text={r('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={r('listLabel')}>
              <thead>
                <tr className="border-b border-border text-start text-muted-foreground">
                  {(['order', 'name', 'event', 'state', 'actions'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {r(`columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, index) => (
                  <tr key={rule.ruleId} data-rule={rule.name} className="border-b border-border align-top last:border-b-0">
                    <td className="px-3 py-3 tabular-nums">{index + 1}</td>
                    <th scope="row" className="px-3 py-3 text-start font-normal">
                      <Link href={`/agent/settings/rules/${rule.ruleId}`} className="break-words font-semibold text-link underline-offset-2 hover:underline">
                        {rule.name}
                      </Link>
                      {rule.pcode !== null && <span className="block text-xs text-muted-foreground">{r('builtin')}</span>}
                    </th>
                    <td className="px-3 py-3">
                      {r.has(`events.${rule.event}`) ? r(`events.${rule.event}`) : rule.event}
                      {rule.hours !== null && <span className="block text-xs text-muted-foreground">{`${r('editor.hours')}: ${rule.hours}`}</span>}
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex flex-wrap gap-1">
                        {rule.isEnabled ? (
                          <StatusLabel tone="green">{r('states.enabled')}</StatusLabel>
                        ) : rule.disabledReason === 'loop' ? (
                          <StatusLabel tone="danger">{r('states.loop')}</StatusLabel>
                        ) : (
                          <StatusLabel tone="gray">{r('states.disabled')}</StatusLabel>
                        )}
                        {!rule.isValid && <StatusLabel tone="orange">{r('states.invalid')}</StatusLabel>}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-2">
                        {(['up', 'down'] as const).map((direction) => (
                          <form key={direction} action={moveRuleAction}>
                            <input type="hidden" name="ruleId" value={rule.ruleId} />
                            <input type="hidden" name="direction" value={direction} />
                            <Button
                              type="submit"
                              variant="secondary"
                              size="small"
                              disabled={direction === 'up' ? index === 0 : index === rules.length - 1}
                              aria-label={r(direction === 'up' ? 'moveUpOf' : 'moveDownOf', { name: rule.name })}
                            >
                              {r(direction === 'up' ? 'moveUp' : 'moveDown')}
                            </Button>
                          </form>
                        ))}
                        <form action={setRuleEnabledAction}>
                          <input type="hidden" name="ruleId" value={rule.ruleId} />
                          <input type="hidden" name="enabled" value={rule.isEnabled ? 'false' : 'true'} />
                          <Button type="submit" variant="secondary" size="small" aria-label={r(rule.isEnabled ? 'disableOf' : 'enableOf', { name: rule.name })}>
                            {r(rule.isEnabled ? 'disable' : 'enable')}
                          </Button>
                        </form>
                        <Link href={`/agent/settings/rules/${rule.ruleId}`} className={buttonVariants({ variant: 'secondary', size: 'small' })} aria-label={r('openOf', { name: rule.name })}>
                          {r('open')}
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
