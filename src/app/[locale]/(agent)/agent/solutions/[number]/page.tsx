import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { listActiveModules } from '@/modules/hdr/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { DocView } from '@/ui/doc/DocView';
import type { SolutionEditorLabels } from '@/ui/doc/editor/SolutionEditor';
import type { ScreenshotLabels } from '@/ui/doc/ScreenshotMarkup';
import { restoreVersionAction } from '../actions';
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
const ERRORS = new Set(['forbidden', 'invalid_input', 'not_found']);

export default async function SolutionEditorPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor();
  const { number } = await params;
  if (!/^\d{1,12}$/.test(number)) notFound();
  const state = await solutionEditorState(staff, { number });
  if (!state) notFound();
  const { done, error } = await searchParams;
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.solutions');
  const toolbar = await getTranslations('dev.editor.toolbar');
  const locale = await getLocale();
  const format = await getFormatter();
  const modules = await listActiveModules(staff.actor, locale);
  const filePath = `/${locale}/agent/solutions/${state.number}/files`;
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
    reload: s('save.reload'),
    metaError: s('errors.meta'),
    metaForbidden: s('errors.metaForbidden'),
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
          <StatusLabel tone={state.archived ? 'orange' : published ? 'green' : 'gray'}>
            {s(`statuses.${state.archived ? 'archived' : published ? 'published' : 'draft'}`)}
          </StatusLabel>
          {state.current.state === 'draft' && published && <StatusLabel tone="blue">{s('hasChanges')}</StatusLabel>}
          <span className="text-sm text-secondary-foreground">{s('languageOf', { language: s(`locales.${state.locale}`) })}</span>
        </div>
        {done === 'restored' && <Alert tone="success">{s('versions.restored')}</Alert>}
        {error && ERRORS.has(error) && <Alert tone="danger">{s(`errors.${error}`)}</Alert>}
        {state.archived && <Alert tone="info">{s('archivedNotice')}</Alert>}
        {!state.canWrite && <Alert tone="info">{s('readOnly')}</Alert>}

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
              editable: !state.archived,
            }}
            labels={labels}
            filePath={filePath}
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
