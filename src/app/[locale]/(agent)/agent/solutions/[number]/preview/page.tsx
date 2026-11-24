import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/locales';
import { solutionEditorState } from '@/modules/hdk/api/editor';
import { requireStaffActor } from '@/modules/hdu/api';
import { Card } from '@/ui/components/card';
import { PageHeader } from '@/ui/components/PageHeader';
import { cn } from '@/ui/cn';
import { DocView } from '@/ui/doc/DocView';

// Предпросмотр решения (план M5, задача 3; UX-W-05): последний сохранённый текст той же отрисовкой, что у клиента
// (DocView), в ширине телефона или компьютера. Язык: пока только язык оригинала; переводы добавит задача 6.

const DEVICES = ['phone', 'desktop'] as const;

export default async function SolutionPreviewPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ device?: string; lang?: string }> }) {
  const staff = await requireStaffActor();
  const { number } = await params;
  if (!/^\d{1,12}$/.test(number)) notFound();
  const query = await searchParams;
  const state = await solutionEditorState(staff, {
    number,
    ...(query.lang && isLocale(query.lang) ? { locale: query.lang } : {}),
  });
  if (!state) notFound();
  const device = query.device === 'desktop' ? 'desktop' : 'phone';
  const t = await getTranslations('agent');
  const s = await getTranslations('agent.solutions');
  const locale = await getLocale();
  const filePath = `/${locale}/agent/solutions/${state.number}/files`;
  return (
    <>
      <PageHeader
        title={s('preview.title')}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: s('title'), href: '/agent/solutions' },
          {
            label: s('numberLabel', { number: state.number }),
            href: `/agent/solutions/${state.number}`,
          },
          { label: s('preview.title') },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex flex-col gap-4">
        <nav aria-label={s('preview.devices')} className="flex flex-wrap gap-2">
          {DEVICES.map((value) => (
            <Link
              key={value}
              href={`/agent/solutions/${state.number}/preview?device=${value}&lang=${state.locale}`}
              aria-current={device === value ? 'page' : undefined}
              className={cn('rounded-control border border-border px-3 py-2 text-sm', device === value && 'bg-selected text-selected-foreground')}
            >
              {s(`preview.${value}`)}
            </Link>
          ))}
          <span className="self-center text-sm text-secondary-foreground">{s('languageOf', { language: s(`locales.${state.locale}`) })}</span>
        </nav>
        <p className="text-sm text-secondary-foreground">{s('preview.hint')}</p>
        <Card className={cn('w-full p-4', device === 'phone' ? 'max-w-phone-preview' : 'max-w-prose')} data-testid="solution-preview" data-device={device}>
          <h2 className="mb-3 text-xl font-bold break-words">{state.current.title || s('untitled')}</h2>
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
      </div>
    </>
  );
}
