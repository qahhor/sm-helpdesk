import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { firstParam } from '@/lib/search-params';
import { requireStaffActor } from '@/modules/hdu/api';
import { readMacro } from '@/modules/hdw/api';
import { Alert } from '@/ui/components/alert';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { ConfirmDelete } from '../../ConfirmDelete';
import { actionDrafts } from '../../rules/rule-draft';
import { settingsNav } from '../../sections';
import { deleteMacroAction } from '../actions';
import { macroEditorProps } from '../editor-props';
import { MacroEditor } from '../MacroEditor';

// Макрос: редактор и удаление (FR-AG-15, FR-ADM-10; план M8, задача 6).

const DONE = new Set(['created', 'saved']);
const ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found']);

export default async function MacroPage({ params, searchParams }: PageProps<'/[locale]/agent/settings/macros/[macroId]'>) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const { macroId } = await params;
  const macro = await readMacro(staff, macroId);
  if (!macro) notFound();
  const query = await searchParams;
  const done = firstParam(query.done);
  const error = firstParam(query.error);
  const t = await getTranslations('agent');
  const m = await getTranslations('agent.settings.macros');
  const locale = await getLocale();
  const here = `/${locale}/agent/settings/macros/${macro.macroId}`;
  const { options, labels } = await macroEditorProps(staff);
  return (
    <>
      <PageHeader
        title={macro.name}
        breadcrumbs={[
          { label: t('home.title'), href: '/agent' },
          { label: t('settings.title'), href: '/agent/settings' },
          { label: m('title'), href: '/agent/settings/macros' },
          { label: macro.name },
        ]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...await settingsNav('macros')}>
        {done && DONE.has(done) && <Alert tone="success">{m(`done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && <Alert tone="danger">{m(`errors.${error}`)}</Alert>}
        {!macro.isValid && <Alert tone="danger">{m('invalidNote')}</Alert>}
        {/* Ключ по времени изменения: после сохранения редактор берёт сохранённый макрос заново. */}
        <MacroEditor
          key={macro.modifiedOn.toISOString()}
          initial={{ macroId: macro.macroId, name: macro.name, isEnabled: macro.isEnabled, actions: actionDrafts(macro.actions) }}
          options={options}
          labels={labels}
          reauthHref={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(here)}`}
        />
        <ConfirmDelete
          action={deleteMacroAction}
          field="macroId"
          value={macro.macroId}
          labels={{ open: m('delete.open'), title: m('delete.title', { name: macro.name }), text: m('delete.text'), confirm: m('delete.confirm'), cancel: m('delete.cancel'), close: m('delete.close') }}
        />
      </SettingsLayout>
    </>
  );
}
