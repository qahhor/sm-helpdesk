import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ClientActor, type SystemActor, withActor } from '@/db/with-actor';
import { consumeRateLimit } from '@/modules/hdc/api';
import { cleanUserText, RATE_RULES } from '@/modules/hdc/pref';
import { replyConfig } from '@/modules/hdn/api/inbound';
import { replyRole } from '@/modules/hdu/api/recipients';
import { rateTx } from '../core/actions';
import { parseCsatToken } from '../csat-link';
import { isHdtError } from '../error';
import { CSAT_REASONS } from '../pref';
import { tickets } from '../schema';

// Модуль hdt, слой api: оценка обращения по ссылке из письма, без входа в портал (FR-TK-11, UX-C-07; решение 0040).
// Правом служит подпись ссылки: она называет обращение и автора. Оценку ставит актор клиента, собранный из подписи
// и действующего членства автора: политики RLS и правила базы действуют так же, как при оценке на странице.

const SYSTEM: SystemActor = { type: 'system', job: 'csat.link' };

const linkInput = z.object({ token: z.string().min(1).max(120), score: z.coerce.number().int().min(1).max(5) });
const detailsInput = z.object({
  reason: z.preprocess((value) => (value === '' || value === null ? undefined : value), z.enum(CSAT_REASONS).optional()),
  // Комментарий из одних пробелов или переводов строк считается пустым: человек его не писал.
  comment: z.preprocess((value) => (typeof value !== 'string' || value.trim() === '' ? undefined : value), z.string().overwrite(cleanUserText).trim().max(2000).optional()),
});

export type RateByLinkResult = { ok: true; number: number } | { ok: false; code: 'link_invalid' | 'already_rated' | 'not_closed' | 'reason_required' | 'rate_limited' };

const secrets = (): string[] => {
  const cfg = replyConfig();
  return cfg ? [cfg.secret, ...(cfg.previousSecret ? [cfg.previousSecret] : [])] : [];
};

/** Номер обращения из ссылки: для страницы подтверждения. Базу не читает и ничего не меняет. */
export function csatLinkNumber(token: unknown): number | null {
  return typeof token === 'string' ? (parseCsatToken(token, secrets())?.number ?? null) : null;
}

/**
 * Ставит оценку по ссылке из письма. Негодная подпись, не автор, отключённый участник и несуществующее обращение
 * отвечают одинаково (link_invalid): по ответу нельзя узнать, есть ли обращение с таким номером.
 */
export async function rateByLink(input: unknown, request: { ip: string | null }): Promise<RateByLinkResult> {
  const link = linkInput.safeParse(input);
  if (!link.success) return { ok: false, code: 'link_invalid' };
  const parsed = parseCsatToken(link.data.token, secrets());
  if (!parsed) return { ok: false, code: 'link_invalid' };
  const details = detailsInput.safeParse(input);
  if (!details.success) return { ok: false, code: 'link_invalid' };
  // Причина при оценке 1-3 обязательна, как на странице обращения (FR-TK-11).
  if (link.data.score <= 3 && !details.data.reason) return { ok: false, code: 'reason_required' };
  // Предел на обращение: подпись у ссылки одна на все оценки, перебирать нечего, но запросы к базе ограничены.
  if (!(await consumeRateLimit(`csat-link:${parsed.number}`, RATE_RULES.csatLinkPerTicket)).allowed) return { ok: false, code: 'rate_limited' };

  const ticket = (await withActor(SYSTEM, (tx) => tx.select({ orgId: tickets.orgId, authorId: tickets.authorId }).from(tickets).where(eq(tickets.number, parsed.number)).limit(1)))[0];
  if (!ticket || ticket.authorId !== parsed.userId) return { ok: false, code: 'link_invalid' };
  const role = await replyRole(parsed.userId, ticket.orgId);
  if (!role) return { ok: false, code: 'link_invalid' };
  const client: ClientActor = { type: 'client', userId: parsed.userId, orgId: ticket.orgId, orgRole: role };
  try {
    await rateTx(
      client,
      parsed.number,
      { score: link.data.score, ...(link.data.score <= 3 && details.data.reason ? { reason: details.data.reason } : {}), ...(details.data.comment ? { comment: details.data.comment } : {}) },
      { byLink: true, ip: request.ip },
    );
  } catch (error) {
    if (!isHdtError(error)) throw error;
    if (error.code === 'already_rated') return { ok: false, code: 'already_rated' };
    if (error.code === 'transition_refused') return { ok: false, code: 'not_closed' };
    return { ok: false, code: 'link_invalid' };
  }
  return { ok: true, number: parsed.number };
}
