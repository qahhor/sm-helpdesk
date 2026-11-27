import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { LOCALES } from '@/i18n/locales';
import { firstParam } from '@/lib/search-params';
import { HDP_ERROR_CODES } from '@/modules/hdp/api';
import { listStaffAnnouncements } from '@/modules/hdp/api/announcements';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { serverOptions } from '@/modules/hdu/api/servers';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { StatusLabel, type StatusTone } from '@/ui/components/StatusLabel';
import { Textarea } from '@/ui/components/textarea';
import { announcementTranslationAction, endAnnouncementAction, requestAnnouncementTranslationAction, saveAnnouncementAction } from './actions';

// Объявления на рабочем месте (ТЗ 7.18, FR-ANN-01, FR-ADM-12; план M5c, задача 6, решение 24): список со статусами
// "Запланировано", "Действует", "Закончилось", форма (вид, период, аудитория, текст на языке автора), переводы с
// принятием и досрочное окончание. Пишут care и admin; остальные сотрудники видят список. Время полей: Ташкент.

const DONE = ['saved', 'ended', 'translation', 'translating'];
const FINDING_KINDS = ['phone', 'email', 'inn', 'pinfl', 'digits', 'server', 'internal', 'link', 'org'];
const STATE_TONE: Record<string, StatusTone> = { scheduled: 'blue', active: 'green', ended: 'gray' };
/** Значение поля datetime-local во времени Ташкента. */
const local = (date: Date) => new Date(date.getTime() + 5 * 3_600_000).toISOString().slice(0, 16);

export default async function AgentAnnouncementsPage({ searchParams }: { searchParams: Promise<{ status?: string; kinds?: string }> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.announcements');
  const tp = await getTranslations('agent.problems');
  const ca = await getTranslations('client.announcements');
  const locale = await getLocale();
  const format = await getFormatter();
  const search = await searchParams;
  const status = firstParam(search.status) ?? '';
  const code = status.startsWith('error-') ? status.slice(6) : null;
  const kinds = (firstParam(search.kinds) ?? '')
    .split(',')
    .filter((k) => FINDING_KINDS.includes(k))
    .map((k) => tp(`findings.${k}`))
    .join(', ');
  const canWrite = staff.actor.staffRole === 'care' || staff.actor.staffRole === 'admin';
  const list = await listStaffAnnouncements(staff);
  const modules = await listActiveModules(staff.actor, locale);
  const servers = canWrite ? await serverOptions(staff.actor) : [];
  const moduleName = new Map(modules.map((m) => [m.moduleId, m.name]));
  const now = new Date();
  const when = (date: Date) => format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <>
      <PageHeader title={s('title')} breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title') }]} breadcrumbsLabel={t('breadcrumbs')} />
      <div className="flex flex-col gap-4" data-testid="agent-announcements">
        {code && <Alert tone="danger">{tp(`errors.${(HDP_ERROR_CODES as readonly string[]).includes(code) ? code : 'forbidden'}`, { kinds })}</Alert>}
        {DONE.includes(status) && <Alert tone="success">{s(`done.${status}`)}</Alert>}
        {canWrite && (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">{s('create')}</h2>
            </CardHeader>
            <CardContent>
              <form action={saveAnnouncementAction} className="grid gap-3 tablet:grid-cols-2">
                <input type="hidden" name="locale" value={locale} />
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ann-kind">{s('fields.kind')}</Label>
                  <Select id="ann-kind" name="kind" defaultValue="maintenance">
                    {(['maintenance', 'outage', 'news'] as const).map((value) => (
                      <option key={value} value={value}>
                        {ca(`kinds.${value}`)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ann-audience">{s('fields.audience')}</Label>
                  <Select id="ann-audience" name="audience" defaultValue="all">
                    {(['all', 'server', 'module'] as const).map((value) => (
                      <option key={value} value={value}>
                        {s(`audiences.${value}`)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ann-server">{s('fields.server')}</Label>
                  <Select id="ann-server" name="serverId" defaultValue="" aria-describedby="ann-audience-hint">
                    <option value="">{s('fields.none')}</option>
                    {servers.map((server) => (
                      <option key={server.serverId} value={server.serverId}>
                        {server.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ann-module">{s('fields.module')}</Label>
                  <Select id="ann-module" name="moduleId" defaultValue="" aria-describedby="ann-audience-hint">
                    <option value="">{s('fields.none')}</option>
                    {modules.map((m) => (
                      <option key={m.moduleId} value={m.moduleId}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <p id="ann-audience-hint" className="text-xs text-muted-foreground tablet:col-span-2">
                  {s('fields.audienceHint')}
                </p>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ann-starts">{s('fields.startsOn')}</Label>
                  <Input id="ann-starts" name="startsOn" type="datetime-local" required defaultValue={local(now)} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="ann-ends">{s('fields.endsOn')}</Label>
                  <Input id="ann-ends" name="endsOn" type="datetime-local" required defaultValue={local(new Date(now.getTime() + 86_400_000))} aria-describedby="ann-ends-hint" />
                  <p id="ann-ends-hint" className="text-xs text-muted-foreground">
                    {s('fields.periodHint')}
                  </p>
                </div>
                <div className="flex flex-col gap-1 tablet:col-span-2">
                  <Label htmlFor="ann-title">{s('fields.title')}</Label>
                  <Input id="ann-title" name="title" required maxLength={200} />
                </div>
                <div className="flex flex-col gap-1 tablet:col-span-2">
                  <Label htmlFor="ann-body">{s('fields.body')}</Label>
                  <Textarea id="ann-body" name="body" rows={3} maxLength={3000} aria-describedby="ann-body-hint" />
                  <p id="ann-body-hint" className="text-xs text-muted-foreground">
                    {tp('public.hint')}
                  </p>
                </div>
                <Button type="submit" className="self-start">
                  {s('save')}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
        {list.length === 0 ? (
          <Card>
            <EmptyState title={s('empty')} text={s('emptyText')} />
          </Card>
        ) : (
          <ul className="flex flex-col gap-3">
            {list.map((a) => {
              const original = a.texts.find((x) => x.locale === a.sourceLocale);
              return (
                <li key={a.announcementId}>
                  <Card data-announcement-id={a.announcementId}>
                    <CardContent className="flex flex-col gap-2 pt-4">
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        <StatusLabel tone={STATE_TONE[a.state] ?? 'gray'}>{s(`states.${a.state}`)}</StatusLabel>
                        <span className="font-semibold">{ca(`kinds.${a.kind}`)}</span>
                        <span>
                          {a.audience === 'module' && a.moduleId ? `${s('audiences.module')}: ${moduleName.get(a.moduleId) ?? ''}` : s(`audiences.${a.audience}`)}
                        </span>
                        <span className="text-secondary-foreground">
                          {when(a.startsOn)} - {when(a.endsOn)}
                        </span>
                      </p>
                      <p className="break-words font-semibold">{original?.title ?? ''}</p>
                      {original?.body && <p className="whitespace-pre-wrap break-words text-sm">{original.body}</p>}
                      {canWrite && a.state !== 'ended' && (
                        <div className="flex flex-col gap-3">
                          {LOCALES.filter((l) => l !== a.sourceLocale).map((lang) => {
                            const text = a.texts.find((x) => x.locale === lang);
                            return (
                              <form key={lang} action={announcementTranslationAction} className="flex flex-col gap-1 rounded-control border border-border p-2" lang={lang}>
                                <input type="hidden" name="announcementId" value={a.announcementId} />
                                <input type="hidden" name="locale" value={lang} />
                                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                                  {s('translation', { locale: lang.toUpperCase() })}
                                  {text?.isMachine && <StatusLabel tone={text.accepted ? 'green' : 'blue'}>{text.accepted ? tp('public.accepted') : tp('public.machine')}</StatusLabel>}
                                </p>
                                <Label htmlFor={`ann-${a.announcementId}-${lang}-title`}>{s('fields.title')}</Label>
                                <Input id={`ann-${a.announcementId}-${lang}-title`} name="title" maxLength={200} defaultValue={text?.title ?? ''} />
                                <Label htmlFor={`ann-${a.announcementId}-${lang}-body`}>{s('fields.body')}</Label>
                                <Textarea id={`ann-${a.announcementId}-${lang}-body`} name="body" rows={2} maxLength={3000} defaultValue={text?.body ?? ''} />
                                <div className="flex flex-wrap gap-2">
                                  <Button type="submit" variant="secondary" size="small">
                                    {tp('public.save')}
                                  </Button>
                                  {text?.isMachine && !text.accepted && (
                                    <Button type="submit" size="small" name="accept" value="true">
                                      {tp('public.accept')}
                                    </Button>
                                  )}
                                  <Button type="submit" variant="ghost" size="small" formAction={requestAnnouncementTranslationAction}>
                                    {tp('public.translate')}
                                  </Button>
                                </div>
                              </form>
                            );
                          })}
                          <form action={endAnnouncementAction}>
                            <input type="hidden" name="announcementId" value={a.announcementId} />
                            <Button type="submit" variant="danger" size="small">
                              {s('end')}
                            </Button>
                          </form>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
