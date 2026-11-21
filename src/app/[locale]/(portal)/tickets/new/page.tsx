import { getLocale, getTranslations } from 'next-intl/server';
import { listActiveModules } from '@/modules/hdr/api';
import { ALLOWED_FILE_EXTENSIONS, IMPACTS, MAX_FILES_PER_MESSAGE, parseNumber, TICKET_TYPES, VISIBILITIES } from '@/modules/hdt/api';
import { requireClientActor } from '@/modules/hdu/api';
import { Link } from '@/i18n/navigation';
import { acceptOf } from '../status';
import { NewTicketForm } from './NewTicketForm';

// Новое обращение (ТЗ 8.3, без блока подсказки решений: он появится в M5). Сначала описание, затем поля.
export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ related?: string }> }) {
  const client = await requireClientActor();
  const locale = await getLocale();
  const t = await getTranslations('client.tickets');
  const related = parseNumber(String((await searchParams).related ?? ''));
  const modules = await listActiveModules(client.actor, locale);
  return (
    <>
      <Link href="/tickets" className="self-start text-sm text-link underline-offset-2 hover:underline">
        {t('new.back')}
      </Link>
      <h1 className="text-2xl font-bold">{t('new.title')}</h1>
      <NewTicketForm
        userId={client.actor.userId}
        relatedNumber={related}
        modules={modules.map((m) => ({ value: m.moduleId, label: m.name }))}
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
          impact: t('new.impact'),
          visibility: t('new.visibility'),
          visibilityHint: t('new.visibilityHint'),
          related: related ? t('new.related', { number: `SUP-${related}` }) : '',
          hours: t('new.hours'),
          submit: t('new.submit'),
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
