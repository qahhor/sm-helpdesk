import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/locales';
import { solutionEditorState, solutionLanguages } from '@/modules/hdk/api/editor';
import { solutionSourceThreads } from '@/modules/hdk/api/from-ticket';
import { solutionSignatures } from '@/modules/hdk/api/signatures';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Textarea } from '@/ui/components/textarea';
import { AgentMark } from '@/ui/components/AgentMark';
import { PageHeader } from '@/ui/components/PageHeader';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { DocView } from '@/ui/doc/DocView';
import type { SolutionEditorLabels } from '@/ui/doc/editor/SolutionEditor';
import type { ScreenshotLabels } from '@/ui/doc/ScreenshotMarkup';
import { archiveAction, bindSignatureAction, restoreVersionAction, unbindSignatureAction } from '../actions';
import type { ReviewLabels } from './ReviewPanel';
import { LanguageTabs, TranslationControls } from './Languages';
import { PendingRefresh } from './PendingRefresh';
import { SolutionWorkspace, type WorkspaceLabels } from './SolutionWorkspace';

// Редактор решения (план M5, задача 3; UX-W-01..05): документ с тремя блоками формы, модуль, флаг "только через
// сотрудника", автосохранение, история версий с возвратом и ссылка на предпросмотр. product видит текст только для
// чтения. Редактор грузится после показа страницы (решение 0046).

const TOOLBAR_KEYS = [
  'area',
  'toolbar',
  'bold',
  'italic',
  'code',
  'link',
  'linkPrompt',
  'heading2',
  'heading3',
  'paragraph',
  'bulletList',
  'orderedList',
  'step',
  'calloutWarning',
  'calloutInfo',
  'image',
  'table',
  'addRow',
  'addColumn',
  'deleteTable',
  'moveUp',
  'moveDown',
  'undo',
  'redo',
] as const satisfies readonly (keyof SolutionEditorLabels)[];
const SCREENSHOT_KEYS = [
  'title',
  'description',
  'close',
  'pasteHint',
  'chooseFile',
  'tools',
  'arrow',
  'frame',
  'number',
  'blur',
  'undo',
  'alt',
  'altHint',
  'insert',
  'uploading',
  'failed',
  'notImage',
  'canvas',
] as const satisfies readonly (keyof ScreenshotLabels)[];
const ERRORS = new Set(['forbidden', 'invalid_input', 'not_found', 'no_original']);
const FINDING_KINDS = ['phone', 'email', 'inn', 'pinfl', 'digits', 'server', 'internal', 'link'] as const;

export default async function SolutionEditorPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ done?: string; error?: string; locale?: string; signature?: string; taken?: string }> }) {
  const staff = await requireStaffActor();
  const { number } = await params;
  if (!/^\d{1,12}$/.test(number)) notFound();
  const { done, error, locale: requested, signature: signatureResult, taken } = await searchParams;
  const lang = requested && isLocale(requested) ? requested : undefined;
  const state = await solutionEditorState(staff, { number, ...(lang ? { locale: lang } : {}) });
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.solutions');
  if (!state) {
    // Языка у решения ещё нет: экран "перевода пока нет" с кнопками перевода (UX-W-06).
    const langs = lang ? await solutionLanguages(staff, { number }) : null;
    if (!langs || !lang || lang === langs.originalLocale) notFound();
    const row = langs.languages.find((l) => l.locale === lang);
    return (
      <>
        <PageHeader
          title={s('translations.emptyTitle', { language: s(`locales.${lang}`) })}
          breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/solutions' }, { label: s('numberLabel', { number: langs.number }) }]}
          breadcrumbsLabel={t('breadcrumbs')}
        />
        <div className="flex flex-col gap-4" data-testid="translation-start">
          <LanguageTabs number={langs.number} current={lang} languages={langs.languages} />
          {done === 'requested' && <Alert tone="success">{s('translations.requested')}</Alert>}
          {error && ERRORS.has(error) && <Alert tone="danger">{s(`errors.${error}`)}</Alert>}
          {langs.archived ? (
            <Alert tone="info">{s('archivedNotice')}</Alert>
          ) : !langs.originalPublished ? (
            <Alert tone="info">{s('errors.no_original')}</Alert>
          ) : (
            <TranslationControls number={langs.number} locale={lang} aiStatus={row?.aiStatus ?? null} canWrite={langs.canWrite} hasDraft={false} />
          )}
        </div>
      </>
    );
  }
  const toolbar = await getTranslations('dev.editor.toolbar');
  const locale = await getLocale();
  const format = await getFormatter();
  const modules = await listActiveModules(staff.actor, locale);
  const filePath = `/${locale}/agent/solutions/${state.number}/files`;
  const translation = state.locale !== state.originalLocale;
  const languageRow = state.languages.find((l) => l.locale === state.locale);
  // Исходная переписка обращения рядом с текстом модели (поправка 101, пункт 8; задача 7).
  const threads = translation ? [] : await solutionSourceThreads(staff, { number: state.number });
  // Сигнатуры ошибок решения (задача 8): у статьи, а не у языка, поэтому только на экране оригинала.
  const signatures = translation ? [] : await solutionSignatures(staff, { number: state.number });
  const takenNumber = taken && /^\d{1,12}$/.test(taken) ? taken : null;
  const draftAi = translation ? null : (languageRow?.aiStatus ?? null);
  const viewLabels = { warning: s('view.warning'), info: s('view.info'), step: (n: number) => s('view.step', { n }) };
  const editorLabels = Object.fromEntries(TOOLBAR_KEYS.map((key) => [key, toolbar(key)])) as SolutionEditorLabels;
  const screenshot = Object.fromEntries(SCREENSHOT_KEYS.map((key) => [key, s(`screenshot.${key}`)])) as ScreenshotLabels;
  const labels: WorkspaceLabels = {
    editor: editorLabels,
    screenshot,
    title: s('fields.title'),
    module: s('fields.module'),
    noModule: s('noModule'),
    internal: s('fields.internal'),
    internalHint: s('fields.internalHint'),
    status: {
      saved: s('save.saved'),
      savedAt: s('save.savedAt', { time: '{time}' }),
      dirty: s('save.dirty'),
      saving: s('save.saving'),
      offline: s('save.offline'),
      conflict: s('save.conflict'),
      error: s('save.error'),
      restored: s('save.restored'),
    },
    stale: {
      text: s('save.stale'),
      show: s('save.staleShow'),
      hide: s('save.staleHide'),
      copy: s('save.staleCopy'),
      copied: s('save.staleCopied'),
      discard: s('save.staleDiscard'),
    },
    reload: s('save.reload'),
    metaError: s('errors.meta'),
    metaForbidden: s('errors.metaForbidden'),
    review: {
      title: s('review.title'),
      items: { title: s('review.items.title'), module: s('review.items.module'), steps: s('review.items.steps'), checks: s('review.items.checks'), textRead: s('review.items.textRead'), translations: s('review.items.translations') },
      findingsTitle: s('review.findingsTitle'),
      noFindings: s('review.noFindings'),
      kinds: Object.fromEntries(FINDING_KINDS.map((kind) => [kind, s(`review.kinds.${kind}`)])) as ReviewLabels['kinds'],
      inTitle: s('review.inTitle'),
      show: s('review.show'),
      blocking: s('review.blocking'),
      filesNotClean: s('review.filesNotClean'),
      machine: translation ? s('translations.machineHint') : s('review.machine'),
      textRead: translation ? s('translations.confirm') : s('review.textRead'),
      confirm: s('review.confirm'),
      publish: s('review.publish'),
      publishing: s('review.publishing'),
      republish: s('review.republish'),
      saveFirst: s('review.saveFirst'),
      notReady: s('review.notReady'),
      conflict: s('review.conflict'),
      failed: s('review.failed'),
      untrusted: {
        title: s('untrusted.title'),
        hint: s('untrusted.hint'),
        kinds: { phone: s('untrusted.kinds.phone'), email: s('untrusted.kinds.email'), command: s('untrusted.kinds.command'), code: s('untrusted.kinds.code') },
        checked: s('untrusted.checked'),
      },
      invariants: {
        title: s('translations.invariants.title'),
        hint: s('translations.invariants.hint'),
        kinds: { links: s('translations.invariants.kinds.links'), numbers: s('translations.invariants.kinds.numbers'), quotes: s('translations.invariants.kinds.quotes'), steps: s('translations.invariants.kinds.steps'), data: s('translations.invariants.kinds.data') },
        original: s('translations.invariants.original'),
        translation: s('translations.invariants.translation'),
      },
    },
  };
  const title = state.current.title || s('untitled');
  const published = state.publishedVersionId !== null;

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: s('title'), href: '/agent/solutions' }, { label: s('numberLabel', { number: state.number }) }]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          <Link href={`/agent/solutions/${state.number}/preview`} className={buttonVariants({ variant: 'secondary' })}>
            {s('preview.open')}
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2" data-testid="solution-labels">
          {state.agentDraft && !published && <AgentMark label={t('aiStaff.mark')} />}
          {state.agentDraft?.revisesNumber && (
            <Link href={`/agent/solutions/${state.agentDraft.revisesNumber}`} className="text-sm text-link underline underline-offset-2">
              {t('aiStaff.revises', { ref: s('numberLabel', { number: state.agentDraft.revisesNumber }) })}
            </Link>
          )}
          <StatusLabel tone={state.archived ? 'orange' : published ? 'green' : 'gray'}>
            {s(`statuses.${state.archived ? 'archived' : published ? 'published' : 'draft'}`)}
          </StatusLabel>
          {state.current.state === 'draft' && published && <StatusLabel tone="blue">{s('hasChanges')}</StatusLabel>}
          <span className="text-sm text-secondary-foreground">{s('languageOf', { language: s(`locales.${state.locale}`) })}</span>
        </div>
        {done === 'restored' && <Alert tone="success">{s('versions.restored')}</Alert>}
        {done === 'published' && <Alert tone="success">{s('review.published')}</Alert>}
        {done === 'archived' && <Alert tone="success">{s('archive.done')}</Alert>}
        {done === 'started' && <Alert tone="success">{s('translations.started')}</Alert>}
        {done === 'requested' && <Alert tone="success">{s('translations.requested')}</Alert>}
        {done === 'from_ticket' && <Alert tone="success">{s('fromTicket.created')}</Alert>}
        {done === 'code_signature_taken' && <Alert tone="info">{t('ticket.code.solutionTaken')}</Alert>}
        <LanguageTabs number={state.number} current={state.locale} languages={state.languages} />
        {draftAi === 'pending' && (
          <>
            <Alert tone="info">{s('fromTicket.pending')}</Alert>
            <PendingRefresh />
          </>
        )}
        {draftAi && ['not_confident', 'failed', 'limited', 'unavailable', 'disabled', 'skipped'].includes(draftAi) && threads.length > 0 && (
          <Alert tone={draftAi === 'not_confident' || draftAi === 'failed' ? 'danger' : 'info'} data-testid="draft-ai-status">
            {s(`fromTicket.ai.${draftAi as 'not_confident' | 'failed' | 'limited' | 'unavailable' | 'disabled' | 'skipped'}`)}
          </Alert>
        )}
        {!translation && state.current.isMachine && (
          <p data-testid="machine-mark">
            <StatusLabel tone="purple">{s('versions.machine')}</StatusLabel> <span className="text-sm text-secondary-foreground">{s('fromTicket.machineHint')}</span>
          </p>
        )}
        {translation && !state.archived && (
          <TranslationControls number={state.number} locale={state.locale} aiStatus={languageRow?.aiStatus ?? null} canWrite={state.canWrite} hasDraft={state.current.state === 'draft'} />
        )}
        {error && ERRORS.has(error) && <Alert tone="danger">{s(`errors.${error}`)}</Alert>}
        {state.archived && <Alert tone="info">{s('archivedNotice')}</Alert>}
        {!state.canWrite && <Alert tone="info">{s('readOnly')}</Alert>}

        <div className={(translation && state.original) || threads.length > 0 ? 'grid gap-4 laptop:grid-cols-2' : 'contents'}>
          {translation && state.original && (
            <section aria-labelledby="solution-original" className="flex flex-col gap-2" data-testid="solution-original">
              <h2 id="solution-original" className="text-lg font-semibold">
                {s('translations.originalTitle', { language: s(`locales.${state.originalLocale}`) })}
              </h2>
              <p className="font-semibold break-words" lang={state.originalLocale}>
                {state.original.title}
              </p>
              {state.original.changedBlockIds.length > 0 && <Alert tone="info">{s('translations.changedHint', { count: state.original.changedBlockIds.length })}</Alert>}
              {/* По абзацам: каждый блок оригинала отдельно, изменившиеся с версии перевода подсвечены (UX-W-06). */}
              <Card className="flex flex-col gap-2 p-4" lang={state.originalLocale}>
                {state.original.doc.blocks.map((block) => {
                  const changed = state.original!.changedBlockIds.includes(block.attrs.id);
                  return (
                    <div
                      key={block.attrs.id}
                      data-block-id={block.attrs.id}
                      data-changed={changed ? 'yes' : 'no'}
                      className={changed ? 'rounded-control border-s-4 border-warning bg-card-soft ps-2' : undefined}
                    >
                      {changed && <span className="text-xs font-medium text-secondary-foreground">{s('translations.changed')}</span>}
                      <DocView doc={{ version: 1, blocks: [block] }} labels={viewLabels} imageSrc={(fileId) => `${filePath}/${fileId}`} />
                    </div>
                  );
                })}
              </Card>
            </section>
          )}
        {state.canWrite ? (
          <SolutionWorkspace
            // Новая версия строки (возврат версии, публикация) заново создаёт редактор с её текстом.
            key={`${state.current.versionId}:${state.current.revision}`}
            number={state.number}
            locale={state.locale}
            initial={{
              versionId: state.current.versionId,
              revision: state.current.revision,
              title: state.current.title,
              doc: state.current.doc,
            }}
            canWrite
            modules={modules.map((m) => ({
              moduleId: m.moduleId,
              name: m.name,
            }))}
            meta={{
              moduleId: state.moduleId,
              audience: state.audience,
              editable: !state.archived && !translation,
            }}
            labels={labels}
            filePath={filePath}
            review={state.review}
            isMachine={state.current.isMachine}
            canPublish={state.canPublish}
            archived={state.archived}
          />
        ) : (
          <Card className="p-4">
            <DocView
              doc={state.current.doc}
              labels={{
                warning: s('view.warning'),
                info: s('view.info'),
                step: (n) => s('view.step', { n }),
              }}
              imageSrc={(fileId) => `${filePath}/${fileId}`}
            />
          </Card>
        )}
          {threads.length > 0 && (
            <section aria-labelledby="solution-sources" className="flex flex-col gap-2" data-testid="solution-sources">
              <h2 id="solution-sources" className="text-lg font-semibold">
                {s('fromTicket.sourceTitle')}
              </h2>
              <p className="text-sm text-secondary-foreground">{s('fromTicket.sourceHint')}</p>
              {threads.map((thread) => (
                <Card key={thread.number} className="flex flex-col gap-3 p-4">
                  <Link href={`/agent/tickets/SUP-${thread.number}`} className="font-semibold text-link underline">
                    SUP-{thread.number} {thread.title}
                  </Link>
                  <ol className="flex flex-col gap-2 text-sm">
                    {thread.messages.map((message, index) => (
                      <li key={index} className="flex flex-col gap-1 rounded-control border border-border p-2">
                        <span className="text-xs font-medium text-secondary-foreground">{s(`fromTicket.roles.${message.role}`)}</span>
                        {/* Текст клиента только текстом: без разметки и ссылок. */}
                        <span className="break-words whitespace-pre-wrap">{message.body}</span>
                      </li>
                    ))}
                  </ol>
                </Card>
              ))}
            </section>
          )}
        </div>

 {state.canPublish && published && !state.archived && !translation && (
          <form action={archiveAction} className="flex flex-wrap items-center gap-3" data-testid="solution-archive">
            <input type="hidden" name="number" value={state.number} />
            <p className="text-sm text-secondary-foreground">{s('archive.hint')}</p>
            {/* Снятие с портала необратимо для клиентов до новой публикации: отдельная отметка, браузер не отправит форму без неё. */}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" required className="size-4 accent-primary" />
              {s('archive.confirm')}
            </label>
            <Button type="submit" variant="danger" size="small">
              {s('archive.submit')}
            </Button>
          </form>
        )}

        {!translation && (
          <section id="solution-signatures" aria-labelledby="solution-signatures-title" className="flex flex-col gap-3" data-testid="solution-signatures">
            <h2 id="solution-signatures-title" className="text-lg font-semibold">
              {s('signatures.title')}
            </h2>
            <p className="text-sm text-secondary-foreground">{s('signatures.hint')}</p>
            {signatureResult === 'bound' && <Alert tone="success">{s('signatures.bound')}</Alert>}
            {signatureResult === 'unbound' && <Alert tone="success">{s('signatures.unbound')}</Alert>}
            {signatureResult === 'taken' && takenNumber && <Alert tone="danger">{s('signatures.taken', { number: takenNumber })}</Alert>}
            {signatureResult === 'invalid' && <Alert tone="danger">{s('signatures.invalid')}</Alert>}
            {signatures.length === 0 ? (
              <p className="text-sm text-secondary-foreground">{s('signatures.empty')}</p>
            ) : (
              <Card className="overflow-x-auto">
                <table className="w-full text-sm" aria-label={s('signatures.title')}>
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th scope="col" className="px-3 py-2 text-start font-medium">{s('signatures.code')}</th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">{s('signatures.sample')}</th>
                      <th scope="col" className="px-3 py-2 text-start font-medium">{s('signatures.seen')}</th>
                      {state.canWrite && <th scope="col" className="px-3 py-2" />}
                    </tr>
                  </thead>
                  <tbody>
                    {signatures.map((row) => (
                      <tr key={row.signatureId} data-signature={row.signatureId} className="border-b border-border align-top last:border-b-0">
                        <td className="px-3 py-3 font-mono whitespace-nowrap">{row.sampleCode ?? s('signatures.noCode')}</td>
                        <td className="px-3 py-3 break-words">{row.sampleMessage ?? s('signatures.noSample')}</td>
                        <td className="px-3 py-3">{s('signatures.seenValue', { orgs: row.orgCount, times: row.occurrences })}</td>
                        {state.canWrite && (
                          <td className="px-3 py-3">
                            <form action={unbindSignatureAction}>
                              <input type="hidden" name="number" value={state.number} />
                              <input type="hidden" name="signatureId" value={row.signatureId} />
                              <Button type="submit" variant="secondary" size="small" aria-label={s('signatures.unbindOf', { code: row.sampleCode ?? s('signatures.noCode') })}>
                                {s('signatures.unbind')}
                              </Button>
                            </form>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
            {state.canWrite && !state.archived && (
              <Card>
                <CardContent className="pt-4">
                  <form action={bindSignatureAction} className="flex flex-col gap-3" aria-label={s('signatures.addTitle')}>
                    <h3 className="text-base font-semibold">{s('signatures.addTitle')}</h3>
                    <input type="hidden" name="number" value={state.number} />
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="signature-code">{s('signatures.codeLabel')}</Label>
                      <Input id="signature-code" name="errorCode" maxLength={80} autoComplete="off" aria-describedby="signature-code-hint" className="max-w-xs" />
                      <p id="signature-code-hint" className="text-sm text-muted-foreground">
                        {s('signatures.codeHint')}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="signature-text">{s('signatures.textLabel')}</Label>
                      <Textarea id="signature-text" name="errorText" maxLength={2000} aria-describedby="signature-text-hint" className="min-h-20" />
                      <p id="signature-text-hint" className="text-sm text-muted-foreground">
                        {s('signatures.textHint')}
                      </p>
                    </div>
                    <Button type="submit" variant="secondary" size="small" className="self-start">
                      {s('signatures.add')}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            )}
          </section>
        )}

        <section aria-labelledby="solution-versions" className="flex flex-col gap-3">
          <h2 id="solution-versions" className="text-lg font-semibold">
            {s('versions.title')}
          </h2>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={s('versions.title')} data-testid="solution-versions">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {(['number', 'state', 'title', 'modified', 'actions'] as const).map((column) => (
                    <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                      {s(`versions.columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.versions.map((version) => (
                  <tr key={version.versionId} data-version={version.number} className="border-b border-border align-top last:border-b-0">
                    <td className="px-3 py-3 tabular-nums">{version.number}</td>
                    <td className="px-3 py-3">
                      <span className="flex flex-wrap gap-1">
                        <StatusLabel tone={version.state === 'published' ? 'green' : version.state === 'draft' ? 'blue' : 'gray'}>
                          {s(`versions.states.${version.state}`)}
                        </StatusLabel>
                        {version.isMachine && <StatusLabel tone="purple">{s('versions.machine')}</StatusLabel>}
                      </span>
                    </td>
                    <td className="px-3 py-3 break-words">{version.title || s('untitled')}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {format.dateTime(version.modifiedOn, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-3 py-3">
                      {state.canWrite && version.state !== 'draft' && (
                        <form action={restoreVersionAction}>
                          <input type="hidden" name="number" value={state.number} />
                          <input type="hidden" name="locale" value={state.locale} />
                          <input type="hidden" name="versionId" value={version.versionId} />
                          <Button
                            type="submit"
                            variant="secondary"
                            size="small"
                            aria-label={s('versions.restoreOf', {
                              number: version.number,
                            })}
                          >
                            {s('versions.restore')}
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-sm text-secondary-foreground">{s('versions.hint')}</p>
        </section>
      </div>
    </>
  );
}
