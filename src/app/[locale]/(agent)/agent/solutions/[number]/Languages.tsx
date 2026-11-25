import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { SolutionLanguage } from '@/modules/hdk/api/editor';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { cn } from '@/ui/cn';
import { translationAction } from '../actions';
import { PendingRefresh } from './PendingRefresh';

// Языки решения (план M5, задача 6; UX-W-06, решение 9): переключатель оригинала и переводов с их состоянием, кнопки
// "Перевести с AI" и "Перевести самому", состояние задачи модели. Модель вызывает фоновый процесс: пока задача идёт,
// страница обновляется сама.

export async function LanguageTabs({ number, current, languages }: { number: number; current: string; languages: SolutionLanguage[] }) {
  const s = await getTranslations('agent.solutions');
  return (
    <nav aria-label={s('translations.tabsLabel')} className="flex flex-wrap gap-2" data-testid="solution-languages">
      {languages.map((lang) => {
        const status = lang.isOriginal ? null : lang.status && lang.published ? lang.status : lang.draft ? 'draft' : 'none';
        return (
          <Link
            key={lang.locale}
            href={`/agent/solutions/${number}?locale=${lang.locale}`}
            aria-current={lang.locale === current ? 'page' : undefined}
            data-locale={lang.locale}
            className={cn('flex items-center gap-2 rounded-control border px-3 py-1 text-sm', lang.locale === current ? 'border-primary font-semibold' : 'border-border')}
          >
            {s(`locales.${lang.locale}`)}
            {lang.isOriginal ? (
              <span className="text-secondary-foreground">{s('translations.original')}</span>
            ) : (
              <StatusLabel tone={status === 'reviewed' ? 'green' : status === 'machine' ? 'purple' : status === 'outdated' ? 'orange' : status === 'draft' ? 'blue' : 'gray'}>
                {s(`translations.statuses.${status}`)}
              </StatusLabel>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Состояние задачи модели и кнопки перевода для языка перевода. */
export async function TranslationControls({ number, locale, aiStatus, canWrite, hasDraft }: { number: number; locale: string; aiStatus: SolutionLanguage['aiStatus']; canWrite: boolean; hasDraft: boolean }) {
  const s = await getTranslations('agent.solutions.translations');
  return (
    <div className="flex flex-col gap-2" data-testid="translation-controls" data-ai-status={aiStatus ?? 'none'}>
      {aiStatus === 'pending' && (
        <>
          <Alert tone="info">{s('pending')}</Alert>
          <PendingRefresh />
        </>
      )}
      {aiStatus && ['failed', 'limited', 'unavailable'].includes(aiStatus) && <Alert tone="danger">{s(`ai.${aiStatus as 'failed' | 'limited' | 'unavailable'}`)}</Alert>}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <form action={translationAction}>
            <input type="hidden" name="number" value={number} />
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="mode" value="ai" />
            <Button type="submit" variant="secondary" size="small">
              {hasDraft ? s('translateAiAgain') : s('translateAi')}
            </Button>
          </form>
          {!hasDraft && (
            <form action={translationAction}>
              <input type="hidden" name="number" value={number} />
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="mode" value="manual" />
              <Button type="submit" variant="secondary" size="small">
                {s('translateManual')}
              </Button>
            </form>
          )}
          {hasDraft && <span className="text-sm text-secondary-foreground">{s('translateAiHint')}</span>}
        </div>
      )}
    </div>
  );
}
