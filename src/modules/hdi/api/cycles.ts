import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import { type Locale, LOCALES } from '@/i18n/locales';
import { requestExplanationDraft } from '@/modules/hda/api/translate';
import type { StaffContext } from '@/modules/hdc/api';
import { wakeOutbox } from '@/modules/hdn/api/outbox';
import type { ClientContext } from '@/modules/hdu/api';
import { cyclesTx, decideTx, liveCountsTx, numbersOfTx, titlesForTx } from '../core/cycles';
import { HdiError } from '../error';
import { ideaNumber, parseInput } from '../input';
import { cleanUserText } from '@/modules/hdc/pref';
import { type CycleStatus, EXPLANATION_MAX, IDEA_MODERATOR_ROLES, type IdeaStatus, type VoteMode } from '../pref';
import { noProtoKeys } from '@/lib/no-proto';

// Модуль hdi, слой api: отбор месяца на страницах (ТЗ FR-IDEA-10, 16; план M7, задача 9, решение 17). Сотрудники
// видят текущую пятёрку со снимком и живыми счётчиками и архив; выбирают и пишут объяснение только product и admin.
// Клиент видит только завершённые отборы: выбранную идею, объяснение на своём языке (иначе русское) и пометку "без
// выбора"; кто выбрал, ему не отдаётся. Машинный черновик объяснения видит только сотрудник, сохраняет он сам.

export { runIdeaCycle } from './cycle-job';

const isModerator = (ctx: StaffContext) => ctx.actor.type === 'staff' && (IDEA_MODERATOR_ROLES as readonly string[]).includes(ctx.actor.staffRole);

function requireModerator(ctx: StaffContext): void {
  if (!isModerator(ctx)) throw new HdiError('forbidden');
}

const cycleDate = z.string().regex(/^\d{4}-\d{2}-01$/);

export type StaffShortlistItem = { number: number; place: number; title: string; snapshot: { voteCount: number; orgCount: number }; live: { voteCount: number; orgCount: number; status: IdeaStatus } | null };
export type StaffCycle = { cycle: string; status: CycleStatus; voteMode: VoteMode; leader: number | null; selected: number | null; shortlist: StaffShortlistItem[]; explanation: { ru: string | null; uz: string | null; en: string | null } };

/** Текущий (открытый) отбор и архив для рабочего места. Читает любой сотрудник; canDecide только у product и admin. */
export async function staffCycleBoard(ctx: StaffContext): Promise<{ current: StaffCycle | null; archive: StaffCycle[]; canDecide: boolean }> {
  if (ctx.actor.type !== 'staff') throw new HdiError('forbidden');
  return withActor(ctx.actor, async (tx) => {
    const rows = await cyclesTx(tx, ['open', 'decided', 'lapsed']);
    const ids = [...new Set(rows.flatMap((r) => r.shortlist.map((s) => s.ideaId)))];
    const [titles, live] = await Promise.all([titlesForTx(tx, ids, 'ru'), liveCountsTx(tx, ids)]);
    const view = (row: (typeof rows)[number]): StaffCycle => {
      const numberOf = (id: string | null) => (id ? (row.shortlist.find((s) => s.ideaId === id)?.number ?? null) : null);
      return {
        cycle: row.cycle,
        status: row.status,
        voteMode: row.voteMode,
        leader: numberOf(row.leaderIdeaId),
        selected: numberOf(row.selectedIdeaId),
        shortlist: row.shortlist.map((s) => {
          const now = live.get(s.ideaId);
          return {
            number: s.number,
            place: s.place,
            title: titles.get(s.ideaId) ?? '',
            snapshot: { voteCount: s.voteCount, orgCount: s.orgCount },
            live: now ? { voteCount: now.voteCount, orgCount: now.orgCount, status: now.status as IdeaStatus } : null,
          };
        }),
        explanation: { ru: row.explanationRu, uz: row.explanationUz, en: row.explanationEn },
      };
    };
    const current = rows.find((r) => r.status === 'open');
    return { current: current ? view(current) : null, archive: rows.filter((r) => r.status !== 'open').map(view), canDecide: isModerator(ctx) };
  });
}

/** Объяснение на языке: пустое поле формы это "нет объяснения"; текст очищается от невидимых знаков (решение 13). */
const explanation = z
  .string()
  .max(EXPLANATION_MAX * 2)
  .optional()
  .transform((value) => (value === undefined ? null : cleanUserText(value).trim()))
  .pipe(z.string().max(EXPLANATION_MAX).nullable());
const decideInput = z.strictObject({
  cycle: cycleDate,
  number: ideaNumber,
  explanationRu: explanation,
  explanationUz: explanation,
  explanationEn: explanation,
  // Отметки машинного черновика по языку (пункт M6 итоговой проверки): форма снимает их при правке или отметке "проверено".
  explanationUzMachine: z.boolean().optional().default(false),
  explanationEnMachine: z.boolean().optional().default(false),
});

/**
 * Выбор идеи месяца (FR-IDEA-10, решение 17). Отказы: forbidden, invalid_input (в том числе объяснение из одних
 * пробелов), not_found, cycle_closed, not_in_shortlist, explanation_required, bad_transition. Изменить выбор нельзя.
 */
export async function decideCycle(ctx: StaffContext, input: unknown): Promise<{ number: number }> {
  requireModerator(ctx);
  const raw = noProtoKeys(z.looseObject({ explanationRu: z.unknown().optional() })).safeParse(input);
  // Поле передано, но после очистки пусто: это ошибка ввода, а не "без объяснения".
  if (raw.success && typeof raw.data.explanationRu === 'string' && raw.data.explanationRu.length > 0 && cleanUserText(raw.data.explanationRu).trim() === '') throw new HdiError('invalid_input');
  const data = parseInput(decideInput, input);
  const empty = (value: string | null) => (value ? value : null);
  const { idea } = await withActor(ctx.actor, (tx) =>
    decideTx(tx, data.cycle, {
      number: data.number,
      explanationRu: empty(data.explanationRu),
      explanationUz: empty(data.explanationUz),
      explanationEn: empty(data.explanationEn),
      uzMachine: data.explanationUzMachine,
      enMachine: data.explanationEnMachine,
    }),
  );
  await wakeOutbox();
  return { number: idea.number };
}

/**
 * Машинный черновик объяснения на узбекском и английском по русскому тексту (решение 17). Только product и admin;
 * ничего не сохраняет. Модель недоступна или исчерпан суточный предел: черновика нет, сотрудник пишет сам.
 */
export async function draftCycleExplanation(ctx: StaffContext, input: unknown): Promise<{ uz: string | null; en: string | null; machine: true }> {
  requireModerator(ctx);
  const { text } = parseInput(z.strictObject({ text: z.string().transform((v) => cleanUserText(v).trim()).pipe(z.string().min(1).max(EXPLANATION_MAX)) }), input);
  const system = { type: 'system' as const, job: 'ideas.explanation_draft' };
  const draft = async (to: 'uz' | 'en') => {
    const outcome = await requestExplanationDraft(system, { from: 'ru', to, text });
    return outcome.status === 'ok' ? outcome.value.slice(0, EXPLANATION_MAX) : null;
  };
  const uz = await draft('uz');
  const en = await draft('en');
  return { uz, en, machine: true };
}

export type ClientCycle = {
  cycle: string;
  status: 'decided' | 'lapsed';
  idea: { number: number; title: string } | null;
  explanation: string | null;
  explanationLocale: Locale;
  /** Показанный текст из машинного черновика без проверки: страница ставит пометку "Машинный перевод". */
  explanationMachine: boolean;
};

/** Архив выборов для клиента (FR-IDEA-16): завершённые отборы, выбранная идея, объяснение на языке клиента или русское. */
export async function clientCycleArchive(ctx: Pick<ClientContext, 'actor'>, input: unknown): Promise<ClientCycle[]> {
  const { locale } = parseInput(z.strictObject({ locale: z.enum(LOCALES) }), input);
  return withActor(ctx.actor, async (tx) => {
    const rows = await cyclesTx(tx, ['decided', 'lapsed']);
    const selected = rows.flatMap((r) => (r.selectedIdeaId ? [r.selectedIdeaId] : []));
    const [titles, numbers] = await Promise.all([titlesForTx(tx, selected, locale), numbersOfTx(tx, selected)]);
    return rows.map((row) => {
      const number = row.selectedIdeaId ? numbers.get(row.selectedIdeaId) : undefined;
      const text = locale === 'uz' ? row.explanationUz : locale === 'en' ? row.explanationEn : row.explanationRu;
      const machine = (locale === 'uz' && row.explanationUzMachine) || (locale === 'en' && row.explanationEnMachine);
      return {
        cycle: row.cycle,
        status: row.status === 'decided' ? 'decided' : 'lapsed',
        // Выбранная идея не видна клиенту (например, отклонена позже): строка без идеи, как у отбора без выбора.
        idea: row.selectedIdeaId && number !== undefined ? { number, title: titles.get(row.selectedIdeaId) ?? '' } : null,
        explanation: text ?? row.explanationRu,
        explanationLocale: text ? locale : 'ru',
        explanationMachine: Boolean(text) && machine,
      };
    });
  });
}
