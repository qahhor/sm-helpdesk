import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { firstParam } from '@/lib/search-params';
import { codeEntryCard, type CodeEntryCard } from '@/modules/hda/api/code-knowledge';
import { CODE_KINDS, CODE_READER_ROLES, CODE_TEMPLATE_LOCALES } from '@/modules/hda/api/constants';
import { isHdaError } from '@/modules/hda/api/agent-admin';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Textarea } from '@/ui/components/textarea';
import { approveEntryAction, editEntryAction, rejectEntryAction } from '../actions';
import { CODE_STATUS_TONE } from '../status-tone';

// Карточка записи каталога ошибок (ТЗ 8.12 "Знания из кода", FR-CODE-02, 03, 12; план M8c, задача 4): шаблоны сообщения,
// условия, что проверить, место в коде ссылкой (объект, файл, строка). Кода в портале нет. "Утвердить", "Править",
// "Отклонить" для agent_l2, care, admin. Тексты агента выводятся обычным текстом.

const DONE = ['approved', 'rejected', 'edited'] as const;
const label = 'text-xs font-medium text-secondary-foreground';

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export default async function CodeEntryPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: [...CODE_READER_ROLES] });
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.codeKnowledge');
  const format = await getFormatter();
  const key = safeDecode((await params).key);
  const search = await searchParams;
  let card: CodeEntryCard;
  try {
    card = await codeEntryCard(staff, { key });
  } catch (error) {
    if (isHdaError(error) && (error.code === 'not_found' || error.code === 'invalid_input')) notFound();
    throw error;
  }
  const done = firstParam(search.done);
  const error = firstParam(search.error);
  const when = (date: Date) => format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
  const hidden = <input type="hidden" name="key" value={card.key} />;
  // Версия, которую видит сотрудник: запись изменилась, пока страница открыта, будет conflict (находка I7).
  const versioned = (
    <>
      {hidden}
      <input type="hidden" name="version" value={card.version} />
    </>
  );
  const editable = card.status !== 'removed';
  return (
    <>
      <PageHeader
        title={card.key}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/code-knowledge' }, { label: card.key }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="grid gap-4 laptop:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 laptop:col-span-2">
          {done && (DONE as readonly string[]).includes(done) && <Alert tone="success">{s(`card.done.${done}`)}</Alert>}
          {error && <Alert tone="danger">{s.has(`errors.${error}`) ? s(`errors.${error}`) : s('errors.not_found')}</Alert>}
          <Card>
            <CardContent className="flex flex-col gap-3 pt-6 text-sm" data-code-card>
              <p className="flex flex-wrap items-center gap-2">
                <StatusLabel tone={CODE_STATUS_TONE[card.status]}>{s(`statuses.${card.status}`)}</StatusLabel>
                {card.highlighted && <StatusLabel tone="orange">{s(`changes.${card.changeKind === 'changed' ? 'changed' : 'new'}`)}</StatusLabel>}
                {card.code && <span className="font-semibold">{card.code}</span>}
                <span>{s(`kinds.${card.kind}`)}</span>
                <span className="text-secondary-foreground">
                  {s('columns.confidence')}: {Math.round(card.confidence * 100)}%
                </span>
              </p>
              <h2 className={label}>{s('card.template')}</h2>
              <ul className="flex flex-col gap-1">
                {card.templates.map((template) => (
                  <li key={template.locale} className="break-words">
                    <span className="me-2 font-semibold uppercase">{template.locale}</span>
                    {template.template}
                  </li>
                ))}
              </ul>
              <h2 className={label}>{s('card.conditions')}</h2>
              <p className="whitespace-pre-wrap break-words">{card.conditions}</p>
              <h2 className={label}>{s('card.userCause')}</h2>
              <p className="whitespace-pre-wrap break-words">{card.userCause}</p>
              <h2 className={label}>{s('card.whatToCheck')}</h2>
              <ol className="list-decimal ps-5">
                {card.whatToCheck.map((item, i) => (
                  <li key={i} className="break-words">
                    {item}
                  </li>
                ))}
              </ol>
              <h2 className={label}>{s('card.raisedIn')}</h2>
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {card.raisedIn.map((place, i) => (
                  <li key={i} className="break-all">
                    {place.line ? s('card.location', { object: place.object, path: place.path, line: place.line }) : s('card.locationNoLine', { object: place.object, path: place.path })}
                  </li>
                ))}
              </ul>
              <p className="text-secondary-foreground">{s('card.raisedInHint')}</p>
              {card.scan && <p className="text-secondary-foreground">{s('card.scan', { scan: card.scan.scanKey, commit: card.scan.commit, date: when(card.scan.receivedOn) })}</p>}
              {card.approvedOn && <p className="text-secondary-foreground">{s('card.approvedOn', { date: when(card.approvedOn) })}</p>}
              {card.rejectReason && <p className="whitespace-pre-wrap break-words text-secondary-foreground">{s('card.rejectReason', { reason: card.rejectReason })}</p>}
            </CardContent>
          </Card>
          {editable && (
            <details className="rounded-card border border-border bg-card p-4">
              <summary className="cursor-pointer font-semibold">{s('card.edit')}</summary>
              <form action={editEntryAction} className="mt-3 flex flex-col gap-3">
                {versioned}
                <p className="text-sm text-secondary-foreground">{s('card.editHint', { example: '{product}' })}</p>
                {CODE_TEMPLATE_LOCALES.map((locale) => (
                  <div key={locale} className="flex flex-col gap-1">
                    <Label htmlFor={`code-template-${locale}`}>{s('card.templateFor', { locale: locale.toUpperCase() })}</Label>
                    <Input id={`code-template-${locale}`} name={`template_${locale}`} maxLength={500} defaultValue={card.templates.find((x) => x.locale === locale)?.template ?? ''} />
                  </div>
                ))}
                <div className="flex flex-col gap-1">
                  <Label htmlFor="code-conditions">{s('card.conditions')}</Label>
                  <Textarea id="code-conditions" name="conditions" rows={3} maxLength={2000} required defaultValue={card.conditions} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="code-cause">{s('card.userCause')}</Label>
                  <Textarea id="code-cause" name="userCause" rows={3} maxLength={2000} required defaultValue={card.userCause} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="code-check">{s('card.whatToCheck')}</Label>
                  <Textarea id="code-check" name="whatToCheck" rows={4} required aria-describedby="code-check-hint" defaultValue={card.whatToCheck.join('\n')} />
                  <p id="code-check-hint" className="text-xs text-secondary-foreground">
                    {s('card.whatToCheckHint')}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="code-kind">{s('columns.kind')}</Label>
                  <Select id="code-kind" name="kind" defaultValue={card.kind}>
                    {CODE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {s(`kinds.${kind}`)}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button type="submit" className="self-start">
                  {s('card.save')}
                </Button>
              </form>
            </details>
          )}
        </div>
        {editable && (
          <aside className="flex flex-col gap-4" aria-label={s('title')}>
            <Card>
              <CardContent className="flex flex-col gap-3 pt-6">
                {card.status !== 'approved' && (
                  <form action={approveEntryAction}>
                    {versioned}
                    <Button type="submit">{s('card.approve')}</Button>
                  </form>
                )}
                {card.status !== 'rejected' && (
                  <form action={rejectEntryAction} className="flex flex-col gap-2">
                    {hidden}
                    <Label htmlFor="code-reason">{s('card.reason')}</Label>
                    <Textarea id="code-reason" name="reason" rows={2} maxLength={500} />
                    <Button type="submit" variant="secondary" className="self-start">
                      {s('card.reject')}
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
          </aside>
        )}
      </div>
    </>
  );
}
