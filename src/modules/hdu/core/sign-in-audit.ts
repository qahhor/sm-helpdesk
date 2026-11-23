import 'server-only';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { TRUSTED_SIGN_IN_WAYS, type TrustedSignInWay } from '../pref';

// Модуль hdu, слой core: запись входа клиента в журнал аудита (аудит 23.11.2026, находка S8).

export { TRUSTED_SIGN_IN_WAYS };

/** Способы входа клиента: сервер Smartup, ссылка на email, приглашение, бот Telegram. */
export type ClientSignInMethod = 'smartup' | 'email_link' | TrustedSignInWay | 'other';

const SYSTEM = { type: 'system', job: 'auth.sign-in' } as const;

/** Запись user.signed_in: способ входа и адрес запроса. Ни адреса почты, ни токена в записи нет. */
export async function noteClientSignIn(userId: string, method: ClientSignInMethod, ip: string | null): Promise<void> {
  await withIdentity(SYSTEM, (tx) => writeAudit(tx, { action: 'user.signed_in', objectType: 'user', objectId: userId, diff: { method }, ip }));
}
