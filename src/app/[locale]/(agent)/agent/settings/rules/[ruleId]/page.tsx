import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { requireStaffActor } from '@/modules/hdu/api';
import { listRuleRuns, readRule } from '@/modules/hdw/api';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { settingsNav } from '../../sections';
import { DeleteRule } from '../DeleteRule';
import { ruleEditorProps } from '../editor-props';
import { RuleEditor } from '../RuleEditor';
import { draftOf } from '../rule-draft';
import { actionTexts } from '../run-text';

// Правило автоматизации: редактор, пробный прогон и журнал срабатываний (FR-AUTO-01, 08, 09; план M8, задача 4).
// Журнал показывает итог и действия каждого срабатывания, по 50 строк, новые сверху.

const DONE = new Set(['created', 'saved']);
const ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found', 'builtin_rule']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULT_TONES = { applied: 'green', partial: 'orange', failed: 'danger', skipped_loop: 'danger', no_match: 'gray' } as const;

export default async function RulePage({ params, searchParams }: PageProps<'/[locale]/agent/settings/rules/[ruleId]'>) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const { ruleId } = await params;
  const rule = await readRule(staff, ruleId);
  if (!rule) notFound();
  const query = await searchParams;
  const done = firstParam(query.done);
  const error = firstParam(query.error);
  const cursorParam = firstParam(query.cursor);
  const cursor = cursorParam && UUID.test(cursorParam) ? cursorParam : null;
  const t = await getTranslations('agent');
  const r = await getTranslations('agent.settings.rules');
  const format = await getFormatter();
  const locale = await getLocale();
  const here = `/agent/settings/rules/${rule.ruleId}`;
  const [{ options, labels }, runs, describe] = await Promise.all([ruleEditorProps(staff, rule), listRuleRuns(staff, { ruleId: rule.ruleId, cursor }), actionTexts()]);
  const state = rule.isEnabled ? (
    <StatusLabel tone="green">{r('states.enabled')}</StatusLabel>
  ) : rule.disabledReason === 'loop' ? (
    <StatusLabel tone="danger">{r('states.loop')}</StatusLabel>
  ) : (
    <StatusLabel tone="gray">{r('states.disabled')}</StatusLabel>
  );
  return (
    <>
      <PageHeader
        title={rule.name}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: r('title'), href: '/agent/settings/rules' },
          { label: rule.name },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('rules')}>
        {done && DONE.has(done) && <Alert tone="success">{r(`done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && <Alert tone="danger">{r(`errors.${error}`)}</Alert>}
        {rule.disabledReason === 'loop' && <Alert tone="danger">{r('loopNote')}</Alert>}
        {!rule.isValid && <Alert tone="danger">{r('invalidNote')}</Alert>}
        {/* Ключ по времени изменения: после сохранения редактор берёт сохранённое правило заново. */}
        <RuleEditor
          key={rule.modifiedOn.toISOString()}
          initial={draftOf(rule)}
          options={options}
          labels={labels}
          reauthHref={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}${here}`)}`}
          state={state}
        />
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <h2 className="text-lg font-semibold">{r('runs.title')}</h2>
            <p className="text-sm text-secondary-foreground">{r('runs.intro')}</p>
            {runs.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{r('runs.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" aria-label={r('runs.title')}>
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      {(['ticket', 'result', 'actions', 'time'] as const).map((column) => (
                        <th key={column} scope="col" className="px-2 py-2 text-start font-medium">
                          {r(`runs.columns.${column}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {runs.items.map((run) => (
                      <tr key={run.runId} data-run={run.ticketNumber ?? ''} className="border-b border-border align-top last:border-b-0">
                        <td className="whitespace-nowrap px-2 py-2">
                          {run.ticketNumber === null ? (
                            r('runs.noTicket')
                          ) : (
                            <Link href={`/agent/tickets/SUP-${run.ticketNumber}`} className="text-link underline-offset-2 hover:underline">
                              SUP-{run.ticketNumber}
                            </Link>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <StatusLabel tone={RESULT_TONES[run.result] ?? 'gray'}>{r.has(`results.${run.result}`) ? r(`results.${run.result}`) : run.result}</StatusLabel>
                        </td>
                        <td className="px-2 py-2">{describe(run.actions, 'runs.notDone').join('; ')}</td>
                        <td className="whitespace-nowrap px-2 py-2">{format.dateTime(run.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap gap-4">
              {cursor && (
                <Link href={here} className="text-sm text-link underline-offset-2 hover:underline">
                  {r('runs.first')}
                </Link>
              )}
              {runs.nextCursor && (
                <Link href={`${here}?cursor=${runs.nextCursor}`} className="text-sm text-link underline-offset-2 hover:underline">
                  {r('runs.next')}
                </Link>
              )}
            </div>
          </CardContent>
        </Card>
        {rule.pcode === null ? (
          <DeleteRule
            ruleId={rule.ruleId}
            labels={{ open: r('delete.open'), title: r('delete.title', { name: rule.name }), text: r('delete.text'), confirm: r('delete.confirm'), cancel: r('delete.cancel'), close: r('delete.close') }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{r('errors.builtin_rule')}</p>
        )}
      </SettingsLayout>
    </>
  );
}
