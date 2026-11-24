import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getEnv } from '@/env';
import { safeParseSolutionDoc, type SolutionDoc } from '@/modules/hdk/api/doc';
import { Alert } from '@/ui/components/alert';
import { DocView } from '@/ui/doc/DocView';
import type { SolutionEditorLabels } from '@/ui/doc/editor/SolutionEditor';
import { showcaseEnabled } from '@/ui/showcase';
import { TrialEditor } from './TrialEditor';

// Проба редактора решений (план M5, задача 1; ТЗ 18.4). Страница для разработчиков, открыта только при
// HUB_SHOWCASE=1, как витрина компонентов (docs/decisions/0008-showcase-flag.md), иначе 404.
// Слева редактор Tiptap, справа тот же документ, отрисованный на сервере компонентами (DocView).
// "Сохранить" кладёт документ в адрес страницы (?doc=), сервер проверяет его схемой и рисует заново:
// так проба проходит круг "сохранение и загрузка" без таблиц, которые появятся в задаче 2.

const MAX_PARAM = 64 * 1024;

function decode(param: string | string[] | undefined): SolutionDoc | 'invalid' | null {
  if (typeof param !== 'string' || param === '') return null;
  if (param.length > MAX_PARAM) return 'invalid';
  try {
    const parsed = safeParseSolutionDoc(JSON.parse(Buffer.from(param, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : 'invalid';
  } catch {
    return 'invalid';
  }
}

export default async function EditorTrialPage({ searchParams }: PageProps<'/[locale]/dev/editor'>) {
  if (!showcaseEnabled(getEnv())) notFound();
  const param = (await searchParams).doc;
  const t = await getTranslations('dev.editor');
  const locale = await getLocale();
  const imageSrc = `/${locale}/dev/editor/sample-image`;

  const p = (id: string, text: string) => ({ type: 'paragraph' as const, attrs: { id }, content: [{ type: 'text' as const, text }] });
  const cell = (type: 'tableCell' | 'tableHeader', id: string, text: string) => ({ type, attrs: { colspan: 1, rowspan: 1 }, content: [p(id, text)] });
  const sample: SolutionDoc = {
    version: 1,
    blocks: [
      { type: 'heading', attrs: { id: 'samplewhath2', level: 2 }, content: [{ type: 'text', text: t('sample.whatHeading') }] },
      p('samplewhatp1', t('sample.what')),
      { type: 'heading', attrs: { id: 'sampledoh2xx', level: 2 }, content: [{ type: 'text', text: t('sample.doHeading') }] },
      { type: 'step', attrs: { id: 'samplestep01' }, content: [p('samplestep1p', t('sample.step1')), { type: 'image', attrs: { id: 'sampleimage1', src: imageSrc, alt: t('imageAlt') } }] },
      { type: 'step', attrs: { id: 'samplestep02' }, content: [p('samplestep2p', t('sample.step2'))] },
      { type: 'callout', attrs: { id: 'samplecallou', tone: 'warning' }, content: [p('samplecallop', t('sample.warning'))] },
      {
        type: 'table',
        attrs: { id: 'sampletable1' },
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'samplethcode', t('sample.codeHeader')), cell('tableHeader', 'samplethmean', t('sample.meaningHeader'))] },
          { type: 'tableRow', content: [cell('tableCell', 'sampletdcode', t('sample.code')), cell('tableCell', 'sampletdmean', t('sample.meaning'))] },
        ],
      },
    ],
  };

  const saved = decode(param);
  const doc = saved && saved !== 'invalid' ? saved : sample;
  const toolbar = (key: keyof SolutionEditorLabels) => t(`toolbar.${key}`);
  const labels: SolutionEditorLabels = {
    area: toolbar('area'),
    toolbar: toolbar('toolbar'),
    bold: toolbar('bold'),
    italic: toolbar('italic'),
    code: toolbar('code'),
    link: toolbar('link'),
    linkPrompt: toolbar('linkPrompt'),
    heading2: toolbar('heading2'),
    heading3: toolbar('heading3'),
    paragraph: toolbar('paragraph'),
    bulletList: toolbar('bulletList'),
    orderedList: toolbar('orderedList'),
    step: toolbar('step'),
    calloutWarning: toolbar('calloutWarning'),
    calloutInfo: toolbar('calloutInfo'),
    image: toolbar('image'),
    table: toolbar('table'),
    addRow: toolbar('addRow'),
    addColumn: toolbar('addColumn'),
    deleteTable: toolbar('deleteTable'),
    moveUp: toolbar('moveUp'),
    moveDown: toolbar('moveDown'),
    undo: toolbar('undo'),
    redo: toolbar('redo'),
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>
      {saved === 'invalid' && <Alert tone="danger">{t('invalid')}</Alert>}
      {saved && saved !== 'invalid' && <Alert tone="success">{t('saved')}</Alert>}
      <div className="grid items-start gap-4 desktop:grid-cols-2">
        <section aria-labelledby="trial-editor" className="flex flex-col gap-2">
          <h2 id="trial-editor" className="text-lg font-semibold">
            {t('editorHeading')}
          </h2>
          {/* Новый документ из адреса заново создаёт редактор с этим содержимым. */}
          <TrialEditor key={typeof param === 'string' ? param : 'sample'} initial={doc} labels={labels} saveLabel={t('save')} imageSrc={imageSrc} imageAlt={t('imageAlt')} />
        </section>
        <section aria-labelledby="trial-preview" className="flex flex-col gap-2" data-testid="doc-preview">
          <h2 id="trial-preview" className="text-lg font-semibold">
            {t('previewHeading')}
          </h2>
          <div className="rounded-card border border-border bg-card p-4">
            <DocView doc={doc} labels={{ warning: t('view.warning'), info: t('view.info'), step: (n) => t('view.step', { n }) }} />
          </div>
        </section>
      </div>
    </div>
  );
}
