import 'server-only';
import { and, eq } from 'drizzle-orm';
import { withIdentity } from '@/db/with-identity';
import type { Locale } from '@/i18n/locales';
import { authUser } from '../auth-schema';
import { memberships } from '../schema';

// Модуль hdu, слой core: куда отправить письмо пользователю (решение 2 вехи M4). Адрес берётся в момент отправки:
// сменённый или обезличенный адрес писем не получает. Письмо уходит только на подтверждённый адрес; у гостя
// из письма с неизвестного адреса (решение 12) это адрес, с которого он написал.

const SYSTEM = { type: 'system', job: 'identity.recipient' } as const;

export type MailRecipient = { address: string; locale: Locale | null; name: string };

export async function mailRecipientTx(userId: string): Promise<MailRecipient | null> {
  return withIdentity(SYSTEM, async (tx) => {
    const user = (
      await tx
        .select({ name: authUser.name, email: authUser.email, emailVerified: authUser.emailVerified, claimedEmail: authUser.claimedEmail, locale: authUser.locale })
        .from(authUser)
        .where(eq(authUser.id, userId))
        .limit(1)
    )[0];
    if (!user) return null;
    if (user.emailVerified) return { address: user.email, locale: user.locale ?? null, name: user.name };
    if (!user.claimedEmail) return null;
    const guest = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.source, 'guest')))
      .limit(1);
    return guest.length > 0 ? { address: user.claimedEmail, locale: user.locale ?? null, name: user.name } : null;
  });
}
