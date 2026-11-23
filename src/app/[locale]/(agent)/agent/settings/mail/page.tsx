import { getLocale, getTranslations } from 'next-intl/server';
import { intakeAddress, listBlockedSenders, listSupportAddresses, readOncall } from '@/modules/hdn/api/mail-settings';
import { telegramInfo } from '@/modules/hdn/api/telegram-admin';
import { readTimings } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from '../sections';
import { BlockedSenders } from './BlockedSenders';
import { OncallForm } from './OncallForm';
import { SupportAddresses } from './SupportAddresses';
import { TimingsForm } from './TimingsForm';

// "Уведомления и почта" (FR-EM-14, FR-ADM-14; решения 8, 23, 24 вехи M4): только администратор портала (решение 0019).

type Search = { done?: string; error?: string };

const DONE = new Set(['support', 'test', 'oncall', 'oncallTest', 'timings', 'unblocked']);
const ERRORS = new Set(['forbidden', 'invalid_input', 'oncallTest', 'stale_session']);

/** Имя основного бота для подписи. Telegram недоступен или бот выключен: без имени, страница открывается. */
async function mainBotName(): Promise<string | null> {
  try {
    const info = await telegramInfo();
    return info.enabled ? info.username : null;
  } catch {
    return null;
  }
}

export default async function MailSettingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const locale = await getLocale();
  const params = await searchParams;
  const [addresses, oncall, timings, senders, mainBot, nav] = await Promise.all([
    listSupportAddresses(staff),
    readOncall(staff),
    readTimings(staff),
    listBlockedSenders(staff),
    mainBotName(),
    settingsNav('mail'),
  ]);
  const done = params.done && DONE.has(params.done) ? params.done : null;
  const error = params.error ? (ERRORS.has(params.error) ? params.error : 'other') : null;

  return (
    <>
      <PageHeader
        title={t('settings.mail.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: t('settings.mail.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...nav}>
        {done && <Alert tone="success">{t(`settings.mail.done.${done}`)}</Alert>}
        {error && (
          <Alert tone="danger">
            {t(`settings.mail.errors.${error}`)}
            {error === 'stale_session' && (
              <>
                {' '}
                <a href={`/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}/agent/settings/mail`)}`} className="font-semibold underline">
                  {t('settings.mail.reauth')}
                </a>
              </>
            )}
          </Alert>
        )}
        <SupportAddresses addresses={addresses} intake={intakeAddress()} />
        <OncallForm oncall={oncall} mainBot={mainBot} />
        <TimingsForm timings={timings} />
        <BlockedSenders senders={senders} />
      </SettingsLayout>
    </>
  );
}
