import { getLocale, getTranslations } from 'next-intl/server';
import { IDEA_BODY_MAX, IDEA_FILES_MAX, IDEA_TITLE_MAX, ideaRef, parseIdeaNumber } from '@/modules/hdi/api/constants';
import { listActiveModules } from '@/modules/hdr/api';
import { requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { DraftCleaner } from '@/ui/components/draft-cleaner';
import { NewIdeaForm } from './NewIdeaForm';

// Новая идея (ТЗ 8.3, FR-IDEA-01, FR-TK-01; план M7, задача 2). После отправки та же страница с ?sent=<номер>
// показывает "Идея отправлена на проверку" и удаляет черновик формы, если ушёл именно он.
export default async function NewIdeaPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const client = await requireClientActor();
  const locale = await getLocale();
  const t = await getTranslations('client.ideas');
  const sent = parseIdeaNumber(String((await searchParams).sent ?? ''));
  if (sent) {
    return (
      <>
        <h1 className="text-2xl font-bold">{t('new.sentTitle')}</h1>
        <DraftCleaner userId={client.actor.userId} scopes={['new-idea']} />
        <Card className="flex flex-col gap-3 p-4">
          <Alert tone="success">{t('new.sentText', { ref: ideaRef(sent) })}</Alert>
          <div className="flex flex-col gap-3 tablet:flex-row">
            <Button asChild>
              <Link href={`/ideas/${sent}`}>{t('new.sentOpen')}</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/ideas">{t('new.sentBoard')}</Link>
            </Button>
          </div>
        </Card>
      </>
    );
  }
  const modules = await listActiveModules(client.actor, locale);
  const tf = await getTranslations('client.tickets');
  return (
    <>
      <Link href="/ideas" className="self-start text-sm text-link underline-offset-2 hover:underline">
        {t('new.back')}
      </Link>
      <h1 className="text-2xl font-bold">{t('new.title')}</h1>
      <NewIdeaForm
        userId={client.actor.userId}
        modules={modules.map((m) => ({ value: m.moduleId, label: m.name }))}
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        maxFiles={IDEA_FILES_MAX}
        titleMax={IDEA_TITLE_MAX}
        bodyMax={IDEA_BODY_MAX}
        labels={{
          title: t('new.titleLabel'),
          titleHint: t('new.titleHint'),
          body: t('new.body'),
          bodyHint: t('new.bodyHint'),
          module: t('new.module'),
          moduleNone: t('new.moduleNone'),
          showOrg: t('new.showOrg'),
          showOrgHint: t('new.showOrgHint'),
          submit: t('new.submit'),
          sendAnyway: t('new.sendAnyway'),
          findingsTitle: t('new.findingsTitle'),
          findings: Object.fromEntries(['phone', 'email', 'inn', 'pinfl', 'digits', 'server', 'internal'].map((kind) => [kind, t(`new.findings.${kind}`)])),
          busy: tf('files.busy'),
          moderation: t('new.moderation'),
          errors: Object.fromEntries(['invalid_input', 'rate_limited', 'not_found', 'forbidden'].map((code) => [code, t(`errors.${code}`)])),
          files: {
            add: t('new.files.add'),
            hint: t('new.files.hint'),
            remove: tf.raw('files.remove') as string,
            uploading: tf.raw('files.uploading') as string,
            ready: tf('files.ready'),
            failed: tf('files.failed'),
            errors: Object.fromEntries(['too_many_files', 'file_not_allowed', 'file_too_large', 'rate_limited', 'upload'].map((code) => [code, t(`new.files.errors.${code}`)])),
          },
        }}
      />
    </>
  );
}
