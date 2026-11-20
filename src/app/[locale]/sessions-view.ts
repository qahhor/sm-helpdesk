import 'server-only';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatDateTime } from '@/i18n/format';
import type { Locale } from '@/i18n/locales';
import type { SessionView } from '@/modules/hdu/api';
import type { SessionItem, SessionsListLabels } from '@/ui/components/SessionsList';

/** Сессии для общего компонента списка: подписи устройства и даты по правилам языка, пояс Asia/Tashkent. */
export async function sessionItems(sessions: { items: SessionView[]; hidden: number }): Promise<{ items: SessionItem[]; labels: SessionsListLabels }> {
  const t = await getTranslations('common.sessions');
  const locale = (await getLocale()) as Locale;
  return {
    items: sessions.items.map((s) => ({
      sessionId: s.sessionId,
      device: t('device', { browser: t(`browsers.${s.browser}`), os: t(`os.${s.os}`) }),
      ip: s.ip,
      createdOn: formatDateTime(s.createdOn, locale),
      lastSeenOn: formatDateTime(s.lastSeenOn, locale),
      isCurrent: s.isCurrent,
    })),
    labels: {
      current: t('current'),
      ip: t('ip'),
      unknownIp: t('unknownIp'),
      signedIn: t('signedIn'),
      lastSeen: t('lastSeen'),
      revoke: t('revoke'),
      revokeOthers: t('revokeOthers'),
      hiddenNote: sessions.hidden > 0 ? t('hiddenNote', { count: sessions.hidden }) : null,
    },
  };
}
