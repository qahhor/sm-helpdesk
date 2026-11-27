import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { firstParam } from '@/lib/search-params';
import { HDP_ERROR_CODES, parseProblemRef, problemRef } from '@/modules/hdp/api';
import { broadcastDraft } from '@/modules/hdp/api/broadcasts';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Textarea } from '@/ui/components/textarea';
import { confirmBroadcastAction } from '../../../actions';

// Подтверждение рассылки по известной проблеме (ТЗ 8.12 "Написать обновление всем", 11.14; план M5c, задача 5,
// решение 17): текст на языке автора, переводы на языки получателей рядом (машинный перевод только предложение:
// уходит то, что стоит в поле при подтверждении), "Получат: N обращений, M организаций" и подтверждение. Для
// закрытия то же окно с итоговым текстом: после подтверждения обращения перейдут в "Решено".

const FINDING_KINDS = ['phone', 'email', 'inn', 'pinfl', 'digits', 'server', 'internal', 'link', 'org'];

export default async function BroadcastConfirmPage({ params, searchParams }: { params: Promise<{ number: string; id: string }>; searchParams: Promise<{ status?: string; kinds?: string }> }) {
  const staff = await requireStaffActor();
  const { number: raw, id } = await params;
  const number = parseProblemRef(raw);
  if (!number) notFound();
  const draft = await broadcastDraft(staff, id);
  if (!draft) notFound();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.problems');
  const search = await searchParams;
  const status = firstParam(search.status) ?? '';
  const code = status.startsWith('error-') ? status.slice(6) : null;
  const kinds = (firstParam(search.kinds) ?? '')
    .split(',')
    .filter((k) => FINDING_KINDS.includes(k))
    .map((k) => s(`findings.${k}`))
    .join(', ');
  const others = draft.locales.filter((l) => l !== draft.sourceLocale);
  const title = draft.kind === 'closing' ? s('broadcast.closeTitle') : s('broadcast.title');
  return (
    <>
      <PageHeader
        title={`${problemRef(number)}  ${title}`}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/problems' }, { label: problemRef(number), href: `/agent/problems/${number}` }, { label: title }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex flex-col gap-4" data-testid="broadcast-confirm">
        {code && <Alert tone="danger">{s(`errors.${(HDP_ERROR_CODES as readonly string[]).includes(code) ? code : 'forbidden'}`, { kinds })}</Alert>}
        {draft.status !== 'draft' && <Alert>{s('broadcast.alreadySent')}</Alert>}
        <Alert>
          <p data-testid="broadcast-recipients">{s('broadcast.recipients', { tickets: draft.recipients, orgs: draft.orgs })}</p>
          {draft.kind === 'closing' && <p>{s('broadcast.closeHint')}</p>}
        </Alert>
        <form action={confirmBroadcastAction} className="flex flex-col gap-4">
          <input type="hidden" name="number" value={number} />
          <input type="hidden" name="broadcastId" value={draft.broadcastId} />
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">{s('broadcast.original', { locale: draft.sourceLocale.toUpperCase() })}</h2>
            </CardHeader>
            <CardContent lang={draft.sourceLocale}>
              <p className="whitespace-pre-wrap break-words">{draft.body}</p>
            </CardContent>
          </Card>
          {others.map((lang) => (
            <Card key={lang}>
              <CardContent className="flex flex-col gap-1 pt-6" lang={lang}>
                <Label htmlFor={`broadcast-${lang}`}>{s('broadcast.translation', { locale: lang.toUpperCase() })}</Label>
                <Textarea id={`broadcast-${lang}`} name={`text-${lang}`} rows={4} maxLength={5000} defaultValue={draft.machine[lang] ?? ''} aria-describedby={`broadcast-${lang}-hint`} />
                <p id={`broadcast-${lang}-hint`} className="text-xs text-muted-foreground">
                  {draft.machine[lang] ? s('broadcast.machineHint') : s('broadcast.noMachine')}
                </p>
              </CardContent>
            </Card>
          ))}
          {others.length > 0 && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="fallback" className="mt-1" />
              <span>{s('broadcast.fallback')}</span>
            </label>
          )}
          <Button type="submit" className="self-start" disabled={draft.status !== 'draft'}>
            {draft.kind === 'closing' ? s('broadcast.confirmClose') : s('broadcast.confirm')}
          </Button>
        </form>
      </div>
    </>
  );
}
