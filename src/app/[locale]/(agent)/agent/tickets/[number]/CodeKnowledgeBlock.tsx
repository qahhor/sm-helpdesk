import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { canRequestCodeAnalysis, codeAnalysisState } from '@/modules/hda/api/code-analysis';
import { ticketCodeKnowledge } from '@/modules/hda/api/code-knowledge';
import type { StaffContext } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { createSolutionFromEntryAction, requestAnalysisAction } from './code-actions';

// Блок "Что известно по коду" в правой колонке обращения сотрудника (ТЗ 8.12, FR-CODE-06, 07, 11; план M8c, задача 6,
// решения 16, 17). agent_l2, care, admin: запись по сигнатуре и записи по шаблону, черновики с пометкой "не
// проверено"; условия, что проверить, место в коде ссылкой; "Создать решение из записи". Первая линия: только "Что
// проверить" утверждённой записи. product: блока нет. Тексты из кода выводятся обычным текстом.

const label = 'text-xs font-medium text-secondary-foreground';

export async function CodeKnowledgeBlock({ staff, number }: { staff: StaffContext; number: number }) {
  const t = await getTranslations('agent.ticket.code');
  const knowledge = await ticketCodeKnowledge(staff, { number });
  if (knowledge.view === 'none') return null;
  const hidden = <input type="hidden" name="number" value={number} />;
  // "Разобрать по коду" и состояние анализа (задача 7; FR-CODE-08, 10): только тем, кто видит знания из кода.
  const full = knowledge.view === 'full';
  const [analysis, canAnalyze] = full ? await Promise.all([codeAnalysisState(staff, { number }), canRequestCodeAnalysis(staff, { number })]) : [null, false];
  const format = await getFormatter();
  const time = (date: Date) => format.dateTime(date, { timeStyle: 'short' });
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6 text-sm" data-code-knowledge>
        <h2 className={label}>{t('title')}</h2>
        {knowledge.view === 'checks' ? (
          knowledge.checks.length === 0 ? (
            <p className="text-muted-foreground">{t('none')}</p>
          ) : (
            knowledge.checks.map((check) => (
              <div key={check.key} className="flex flex-col gap-1" data-code-check={check.key}>
                <p className="font-medium">{t('whatToCheck')}</p>
                <ol className="list-decimal ps-5">
                  {check.whatToCheck.map((item, i) => (
                    <li key={i} className="break-words">
                      {item}
                    </li>
                  ))}
                </ol>
              </div>
            ))
          )
        ) : knowledge.entries.length === 0 ? (
          <p className="text-muted-foreground">{t('none')}</p>
        ) : (
          knowledge.entries.map((entry) => (
            <div key={entry.key} className="flex flex-col gap-2 border-b border-border pb-3 last:border-b-0 last:pb-0" data-code-entry={entry.key}>
              <p className="flex flex-wrap items-center gap-2">
                <Link href={`/agent/code-knowledge/${encodeURIComponent(entry.key)}`} className="break-all font-semibold text-link underline underline-offset-2">
                  {entry.key}
                </Link>
                {entry.status === 'approved' ? <StatusLabel tone="green">{t('approved')}</StatusLabel> : <StatusLabel tone="orange">{t('unverified')}</StatusLabel>}
              </p>
              <p className="font-medium">{t('conditions')}</p>
              <p className="whitespace-pre-wrap break-words">{entry.conditions}</p>
              <p className="font-medium">{t('whatToCheck')}</p>
              <ol className="list-decimal ps-5">
                {entry.whatToCheck.map((item, i) => (
                  <li key={i} className="break-words">
                    {item}
                  </li>
                ))}
              </ol>
              {entry.raisedIn.length > 0 && (
                <p className="break-all font-mono text-xs text-secondary-foreground">
                  {t('raisedIn')} {entry.raisedIn.map((place) => (place.line ? `${place.object}, ${place.path}:${place.line}` : `${place.object}, ${place.path}`)).join('; ')}
                </p>
              )}
              {entry.status === 'approved' && knowledge.canCreateSolution && (
                <form action={createSolutionFromEntryAction}>
                  {hidden}
                  <input type="hidden" name="key" value={entry.key} />
                  <Button type="submit" variant="secondary" size="small">
                    {t('createSolution')}
                  </Button>
                </form>
              )}
            </div>
          ))
        )}
        {full && (
          <div className="flex flex-col gap-2 border-t border-border pt-3" data-code-analysis={analysis?.status ?? 'none'}>
            {analysis?.status === 'pending' && <p>{t('pending', { time: time(analysis.requestedOn), due: time(analysis.dueOn) })}</p>}
            {analysis?.status === 'timeout' && <p className="text-secondary-foreground">{t('timeout')}</p>}
            {analysis?.status === 'done' && analysis.finishedOn && <p>{t('done', { time: time(analysis.finishedOn) })}</p>}
            {canAnalyze ? (
              analysis?.status !== 'pending' && (
                <form action={requestAnalysisAction} className="flex flex-col gap-1">
                  {hidden}
                  <Button type="submit" size="small" className="self-start" aria-describedby={`code-analyze-hint-${number}`}>
                    {t('analyze')}
                  </Button>
                  <p id={`code-analyze-hint-${number}`} className="text-xs text-secondary-foreground">
                    {t('analyzeHint')}
                  </p>
                </form>
              )
            ) : (
              <p className="text-xs text-secondary-foreground">{t('aiDisabled')}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
