import { getFormatter, getTranslations } from 'next-intl/server';
import { listCodeScans } from '@/modules/hda/api/code-knowledge';
import { CODE_READER_ROLES } from '@/modules/hda/api/constants';
import { requireStaffActor } from '@/modules/hdu/api';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { PageHeader } from '@/ui/components/PageHeader';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { CodeTabs } from '../CodeTabs';

// История сканирований кода (ТЗ FR-CODE-14, FR-ADM-15; план M8c, задача 4): дата, репозиторий, версия кода, числа
// новых, изменённых и исчезнувших ошибок; у отклонённого отчёта правила, по которым он отклонён. Кода нет.

const RULES = ['code_too_long', 'regex', 'bad_placeholder', 'template_too_loose'] as const;

export default async function CodeScansPage() {
  const staff = await requireStaffActor({ roles: [...CODE_READER_ROLES] });
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.codeKnowledge');
  const format = await getFormatter();
  const scans = await listCodeScans(staff);
  return (
    <>
      <PageHeader
        title={s('tabs.scans')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/code-knowledge' }, { label: s('tabs.scans') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex flex-col gap-4">
        <CodeTabs current="scans" />
        {scans.length === 0 ? (
          <Card>
            <EmptyState title={s('scans.empty')} text={s('emptyText')} />
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={s('tabs.scans')} data-testid="code-scans">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {(['date', 'repository', 'commit', 'result'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {s(`scans.columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scans.map((scan) => (
                  <tr key={scan.scanId} className="border-b border-border align-top last:border-b-0" data-code-scan={scan.scanKey}>
                    <td className="whitespace-nowrap px-3 py-3">{format.dateTime(scan.receivedOn, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                    <td className="break-all px-3 py-3">{scan.repository}</td>
                    <td className="px-3 py-3 font-mono text-xs">{scan.commit}</td>
                    <td className="px-3 py-3">
                      {scan.status === 'accepted' ? (
                        s('scans.accepted', { added: scan.added, changed: scan.changed, removed: scan.removed })
                      ) : (
                        <StatusLabel tone="gray">
                          {s('scans.rejected', {
                            rules: [...new Set(scan.reasons.map((r) => r.rule))]
                              .filter((rule): rule is (typeof RULES)[number] => (RULES as readonly string[]).includes(rule))
                              .map((rule) => s(`scans.rules.${rule}`))
                              .join(', '),
                          })}
                        </StatusLabel>
                      )}
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
