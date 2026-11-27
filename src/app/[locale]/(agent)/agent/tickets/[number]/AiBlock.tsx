import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { triageBlock } from '@/modules/hda/api/triage';
import { listActiveModules } from '@/modules/hdr/api';
import { ticketAiState } from '@/modules/hdt/api/triage';
import type { StaffContext } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { acceptTriageAction } from './actions';

// Блок AI в правой колонке страницы обращения (экран 8.12 "Блок AI в обращении у сотрудника"; UX-A-12, FR-AI-13,
// FR-TRI-02, FR-TRI-03; план M5b, задача 7). Состояние помощника и причина передачи, число ответов, резюме с пометкой
// "AI, не проверено" рядом с исходным текстом, найденные решения с оценкой, предложения разбора с "Принять" и
// "Принять всё", пометка "Проверьте приоритет". Клиент этого блока не видит: страница сотрудника (FR-TRI-06).

const APPLIED = ['module', 'type', 'title'] as const;

export async function AiBlock({ staff, ticketId, number, locale, canWrite }: { staff: StaffContext; ticketId: string; number: number; locale: string; canWrite: boolean }) {
  const [state, block] = await Promise.all([ticketAiState(staff, ticketId), triageBlock(staff, { ticketId }, { locale })]);
  if (!state) return null;
  if (state.aiState === 'none' && block.suggestions.length === 0 && block.found.length === 0) return null;
  const t = await getTranslations('agent.ticket');
  const format = await getFormatter();
  const modules = block.suggestions.some((s) => s.field === 'module') ? await listActiveModules(staff.actor, locale) : [];
  const valueOf = (field: string, value: string) => {
    if (field === 'module') return modules.find((m) => m.moduleId === value)?.name ?? value;
    if (field === 'type') return t.has(`types.${value}`) ? t(`types.${value}`) : value;
    return value;
  };
  const summary = block.suggestions.find((s) => s.field === 'summary');
  const priorityHint = block.suggestions.find((s) => s.field === 'priority_hint' && s.status === 'pending');
  const proposals = block.suggestions.filter((s): s is typeof s & { field: (typeof APPLIED)[number] } => (APPLIED as readonly string[]).includes(s.field));
  const pending = block.suggestions.some((s) => s.status === 'pending');
  const reason = state.aiHandoffReason ? t(`aiReasons.${state.aiHandoffReason}`) : null;

  return (
    <Card data-testid="ai-block">
      <CardContent className="flex flex-col gap-3 pt-6 text-sm">
        <h2 className="text-xs font-medium text-secondary-foreground">{t('ai.title')}</h2>
        <div className="flex flex-col gap-1">
          <p data-ai-state={state.aiState}>{state.aiState === 'handed_off' && reason ? t('ai.handedOff', { reason }) : t(`ai.states.${state.aiState}`)}</p>
          <p>{t('ai.replies', { count: state.aiReplyCount })}</p>
        </div>

        {summary && (
          <section className="flex flex-col gap-1" aria-labelledby="ai-summary">
            <h3 id="ai-summary" className="flex flex-wrap items-center gap-2 font-semibold">
              {t('ai.summary')}
              <StatusLabel tone="orange">{t('ai.unverified')}</StatusLabel>
            </h3>
            <p className="break-words" data-ai-summary>
              {summary.value}
            </p>
            <p className="text-xs text-secondary-foreground">{t('ai.unverifiedHint')}</p>
            {/* Рядом с резюме всегда исходный текст обращения (FR-AI-13). */}
            <details className="rounded-control border border-border p-2">
              <summary className="cursor-pointer">{t('ai.original')}</summary>
              <p className="mt-2 whitespace-pre-wrap break-words" data-ai-original>
                {state.description}
              </p>
            </details>
          </section>
        )}

        {block.found.length > 0 && (
          <section className="flex flex-col gap-1" aria-labelledby="ai-found">
            <h3 id="ai-found" className="font-semibold">
              {t('ai.found')}
            </h3>
            <ul className="flex flex-col gap-1">
              {block.found.map((f) => (
                <li key={f.number} className="flex gap-2">
                  <span className="tabular-nums text-secondary-foreground">{format.number(f.score, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</span>
                  <Link href={`/agent/solutions/${f.number}`} className="break-words text-link underline">
                    {f.title ?? `#${f.number}`}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(proposals.length > 0 || priorityHint) && (
          <section className="flex flex-col gap-2" aria-labelledby="ai-triage">
            <h3 id="ai-triage" className="text-xs font-medium text-secondary-foreground">
              {t('ai.triage')}
            </h3>
            <ul className="flex flex-col gap-2">
              {proposals.map((s) => (
                <li key={s.suggestionId} className="flex flex-wrap items-center justify-between gap-2" data-triage-field={s.field}>
                  <span className="min-w-0 break-words">
                    {t(`ai.fields.${s.field}`)}: <span className="font-semibold">{valueOf(s.field, s.value)}</span>
                  </span>
                  {s.status === 'pending' && canWrite ? (
                    <form action={acceptTriageAction}>
                      <input type="hidden" name="number" value={number} />
                      <input type="hidden" name="field" value={s.field} />
                      <Button type="submit" variant="secondary" size="small" aria-label={t('ai.acceptField', { field: t(`ai.fields.${s.field}`) })}>
                        {t('ai.accept')}
                      </Button>
                    </form>
                  ) : s.status === 'accepted' ? (
                    <StatusLabel tone="green">{t('ai.accepted')}</StatusLabel>
                  ) : null}
                </li>
              ))}
            </ul>
            {pending && canWrite && (
              <form action={acceptTriageAction}>
                <input type="hidden" name="number" value={number} />
                <input type="hidden" name="field" value="all" />
                <Button type="submit" variant="secondary" size="small">
                  {t('ai.acceptAll')}
                </Button>
              </form>
            )}
            {priorityHint && (
              <p className="rounded-control border border-warning bg-warning-bg p-2" data-priority-hint>
                {t('ai.checkPriority')}
              </p>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
