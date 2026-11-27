import { randomUUID } from 'node:crypto';
import { getLocale, getTranslations } from 'next-intl/server';
import { assistantAnswersFirst } from '@/modules/hda/api/eligibility';
import { listActiveModules } from '@/modules/hdr/api';
import { ALLOWED_FILE_EXTENSIONS, IMPACTS, MAX_FILES_PER_MESSAGE, parseNumber, TICKET_TYPES, VISIBILITIES } from '@/modules/hdt/api';
import { requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { Alert } from '@/ui/components/alert';
import { acceptOf } from '../status';
import { NewTicketForm } from './NewTicketForm';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Новое обращение (ТЗ 8.3): описание, подсказка решений, затем поля. Сессию формы для исходов подсказки выдаёт сервер
// (план M5, решение 12); со страницы решения после "Не помогло" она возвращается в адресе (?s=, open=1, FR-SOL-11).
export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ related?: string; s?: string; open?: string; error?: string }> }) {
  const client = await requireClientActor();
  const locale = await getLocale();
  const t = await getTranslations('client.tickets');
  const ti = await getTranslations('client.ideas');
  const search = await searchParams;
  const related = parseNumber(String(search.related ?? ''));
  const sessionId = search.s && UUID.test(search.s) ? search.s.toLowerCase() : randomUUID();
  const modules = await listActiveModules(client.actor, locale);
  const tez = await getTranslations('client.tez');
  const tp = await getTranslations('client.problems');
  // Подпись помощника (FR-AI-19): только если помощник действительно ответит первым.
  const aiFirst = await assistantAnswersFirst(client);
  return (
    <>
      <Link href="/tickets" className="self-start text-sm text-link underline-offset-2 hover:underline">
        {t('new.back')}
      </Link>
      <h1 className="text-2xl font-bold">{t('new.title')}</h1>
      {aiFirst && (
        <p className="text-sm text-secondary-foreground" data-testid="tez-form-hint">
          {tez('formHint')}
        </p>
      )}
      {search.error && <Alert tone="danger">{t.has(`errors.${search.error}`) ? t(`errors.${search.error}`) : t('errors.invalid_input')}</Alert>}
      <NewTicketForm
        userId={client.actor.userId}
        sessionId={sessionId}
        initialOpen={search.open === '1'}
        relatedNumber={related}
        modules={modules.map((m) => ({ value: m.moduleId, label: m.name }))}
        moduleCodes={Object.fromEntries(modules.map((m) => [m.moduleId, m.code]))}
        types={TICKET_TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
        impacts={IMPACTS.map((value) => ({ value, label: t(`impacts.${value}`) }))}
        visibilities={VISIBILITIES.map((value) => ({ value, label: t(`visibilities.${value}`) }))}
        accept={acceptOf(ALLOWED_FILE_EXTENSIONS)}
        maxFiles={MAX_FILES_PER_MESSAGE}
        labels={{
          description: t('new.description'),
          descriptionHint: t('new.descriptionHint'),
          subject: t('new.subject'),
          subjectHint: t('new.subjectHint'),
          type: t('new.type'),
          module: t('new.module'),
          moduleNone: t('new.moduleNone'),
          moduleSearch: t('new.moduleSearch'),
          moduleRecent: t('new.moduleRecent'),
          moduleAll: t('new.moduleAll'),
          impact: t('new.impact'),
          visibility: t('new.visibility'),
          visibilityHint: t('new.visibilityHint'),
          related: related ? t('new.related', { number: `SUP-${related}` }) : '',
          fromWidget: t('new.fromWidget'),
          hours: t('new.hours'),
          submit: t('new.submit'),
          ideaLink: ti('ticketLink'),
          ideaLinkAction: ti('ticketLinkAction'),
          problem: {
            heading: tp('heading'),
            status: tp.raw('status') as string,
            statuses: Object.fromEntries((['investigating', 'cause_found', 'fixing', 'fixed'] as const).map((s) => [s, tp(`statuses.${s}`)])),
            workaround: tp('workaround'),
            open: tp('openWorkaround'),
            affected: tp('affected'),
            affectedHint: tp('affectedHint'),
          },
          suggest: { title: t('new.suggest.title'), exact: t('new.suggest.exact'), notHelped: t('new.suggest.notHelped'), sendAnyway: t('new.suggest.sendAnyway') },
          busy: t('files.busy'),
          errors: Object.fromEntries(
            ['description', 'invalid_input', 'rate_limited', 'too_many_files', 'file_not_allowed', 'file_too_large', 'file_unavailable', 'upload'].map((code) => [code, t(`errors.${code}`)]),
          ),
          files: {
            add: t('files.add'),
            hint: t('files.hint'),
            remove: t.raw('files.remove') as string,
            uploading: t.raw('files.uploading') as string,
            ready: t('files.ready'),
            failed: t('files.failed'),
            errors: Object.fromEntries(['too_many_files', 'file_not_allowed', 'file_too_large', 'rate_limited', 'upload'].map((code) => [code, t(`errors.${code}`)])),
          },
        }}
      />
    </>
  );
}
