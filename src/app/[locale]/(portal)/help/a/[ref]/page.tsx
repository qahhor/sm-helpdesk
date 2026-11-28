import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { clientSolutionPage } from '@/modules/hdk/api/client';
import { listActiveModules } from '@/modules/hdr/api';
import { requireClientActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { buttonVariants } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { DocView } from '@/ui/doc/DocView';
import { Feedback } from './Feedback';

// Страница решения для вошедшего клиента (ТЗ 8.3 "Страница решения"; план M5, задача 4; FR-SOL-15, 17, решения 9, 11,
// 12, 16). Текст только из hdk_published (CLAUDE.md): модуль, пометки перевода, "Помогло" и "Не помогло". Черновик,
// внутреннее и несуществующее решение неразличимы: "не найдено". Снятое решение: "Решение больше не действует" с
// кнопкой нового обращения. Документ рисуется компонентами (DocView), HTML из него не вставляется.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export default async function SolutionPage({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams: Promise<{ s?: string }> }) {
  const client = await requireClientActor();
  const ref = safeDecode((await params).ref);
  if (!ref) notFound();
  const locale = await getLocale();
  const { s: session } = await searchParams;
  const sessionId = session && UUID.test(session) ? session : null;
  const page = await clientSolutionPage(client, { ref, locale });
  if (!page) notFound();
  const t = await getTranslations('client.solution');

  if (page.kind === 'archived')
    return (
      <Card data-testid="solution-archived">
        <EmptyState
          title={t('archived.title')}
          text={t('archived.text')}
          action={
            <Link href="/tickets/new" className={buttonVariants()}>
              {t('newRequest')}
            </Link>
          }
        />
      </Card>
    );

  const { solution } = page;
  // Адрес с устаревшим или пропущенным slug ведёт на верный: одна страница на решение.
  if (ref !== page.canonicalRef) redirect(`/${locale}/help/a/${page.canonicalRef}${sessionId ? `?s=${sessionId}` : ''}`);
  const format = await getFormatter();
  const modules = await listActiveModules(client.actor, locale);
  const moduleNames = solution.moduleIds.map((id) => modules.find((m) => m.moduleId === id)?.name).filter((name): name is string => Boolean(name));
  const files = new Set(solution.fileIds);
  const original = `/${solution.originalLocale}/help/a/${page.canonicalRef}`;
  const languageName = (code: string) => t(`languages.${code}`);

  return (
    <article className="flex flex-col gap-4" data-testid="solution-page" data-locale={solution.locale}>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold break-words">{solution.title}</h1>
        <p className="text-sm text-secondary-foreground">
          {moduleNames.length > 0 && <span>{t('module', { module: moduleNames.join(', ') })} · </span>}
          {t('updated', { date: format.dateTime(solution.publishedOn, { dateStyle: 'medium' }) })}
        </p>
      </header>
      {page.notTranslated && <Alert tone="info">{t('notTranslated', { language: languageName(solution.locale) })}</Alert>}
      {solution.isMachine && (
        <Alert tone="info">
          {t('machine')}{' '}
          <a href={original} className="font-semibold underline" lang={solution.originalLocale}>
            {t('original', { language: languageName(solution.originalLocale) })}
          </a>
        </Alert>
      )}
      {solution.isOutdated && (
        <Alert tone="info">
          {t('outdated')}{' '}
          <a href={original} className="font-semibold underline" lang={solution.originalLocale}>
            {t('original', { language: languageName(solution.originalLocale) })}
          </a>
        </Alert>
      )}
      <Card>
        <CardContent className="pt-6" lang={solution.locale}>
          <DocView
            doc={solution.doc}
            hideEmptySections
            labels={{ warning: t('view.warning'), info: t('view.info'), step: (n) => t('view.step', { n }) }}
            imageSrc={(fileId) => (files.has(fileId.toLowerCase()) ? `/${locale}/help/a/${page.canonicalRef}/files/${fileId.toLowerCase()}` : null)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <Feedback
            number={solution.number}
            sessionId={sessionId}
            labels={{
              question: t('feedback.question'),
              helped: t('feedback.helped'),
              notHelped: t('feedback.notHelped'),
              thanks: t('feedback.thanks'),
              sorry: t('feedback.sorry'),
              newRequest: t('newRequest'),
              failed: t('feedback.failed'),
            }}
          />
        </CardContent>
      </Card>
    </article>
  );
}
