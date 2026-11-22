import 'server-only';
import { consumeRateLimit, ipBucket, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';

// Предел попыток одноразовых ссылок и токенов с одного адреса (ТЗ 14.5, V6 ASVS). Токены длинные и случайные,
// перебор безнадёжен, но поток попыток с одного адреса всё равно останавливается: общий счётчик для входа по ссылке,
// входа из бота, приглашений клиента и сотрудника и подтверждения адреса.

/** Ещё можно пробовать с этого адреса. Иначе через сколько секунд. */
export async function redeemAllowed(ip: string | null): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const limit = await consumeRateLimit(rateKey('token-redeem:ip', ipBucket(ip)), RATE_RULES.tokenRedeemPerIp);
  return limit.allowed ? { ok: true } : { ok: false, retryAfterSec: limit.retryAfterSec };
}
