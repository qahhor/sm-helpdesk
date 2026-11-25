import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import type { StaffContext } from '@/modules/hdc/api';
import { findInText, type FindingKind } from '@/modules/hdk/api/text-checks';
import { findOrgIds, orgSummaries } from '@/modules/hdu/api/staff-lookup';
import { staffDetailTx, type StaffIdeaRow, staffListTx, type StaffText, votesByOrgTx } from '../core/staff';
import { HdiError } from '../error';
import { ideaNumber, parseInput } from '../input';
import { BOARD_QUERY_MAX, IDEA_MODERATOR_ROLES, IDEA_STATUSES, type IdeaStatus, transitionBy } from '../pref';

// Модуль hdi, слой api: идеи на рабочем месте (ТЗ FR-IDEA-15, 8.11; план M7, задача 6, решения 9, 24). Список и
// карточку читают все сотрудники; модерацию и разбивку голосов по организациям и категориям видят только product и
// admin. Имена голосовавших не выдаются никому, включая сотрудников. Организация автора видна сотрудникам всегда.

export type { StaffIdeaRow, StaffText };

const isModerator = (ctx: StaffContext) => ctx.actor.type === 'staff' && (IDEA_MODERATOR_ROLES as readonly string[]).includes(ctx.actor.staffRole);

export type StaffIdeaListRow = StaffIdeaRow & { orgName: string };

const listInput = z.discriminatedUnion('tab', [
  z.strictObject({ tab: z.literal('moderation') }),
  z.strictObject({
    tab: z.literal('all'),
    status: z.enum(IDEA_STATUSES).optional(),
    moduleId: z.uuid().optional(),
    orgId: z.uuid().optional(),
    org: z.string().max(BOARD_QUERY_MAX).optional(),
    q: z.string().max(BOARD_QUERY_MAX).optional(),
    after: ideaNumber.optional(),
  }),
]);

export async function staffIdeaList(ctx: StaffContext, input: unknown): Promise<{ items: StaffIdeaListRow[]; next: number | null }> {
  const data = parseInput(listInput, input);
  let orgIds: string[] | null = null;
  if (data.tab === 'all') {
    if (data.orgId) orgIds = [data.orgId];
    else if (data.org?.trim()) orgIds = await findOrgIds(ctx, data.org.trim());
  }
  const page = await withActor(ctx.actor, (tx) =>
    staffListTx(
      tx,
      data.tab === 'moderation'
        ? { tab: 'moderation' }
        : { tab: 'all', status: data.status ?? null, moduleId: data.moduleId ?? null, orgIds, q: data.q?.trim() || null, after: data.after ?? null },
    ),
  );
  const orgs = await orgSummaries(ctx, [...new Set(page.rows.map((row) => row.orgId))]);
  return { items: page.rows.map((row) => ({ ...row, orgName: orgs.get(row.orgId)?.name ?? '' })), next: page.next };
}

export type Category = 'A' | 'B' | 'C' | 'D';
export type VoteBreakdown = { orgs: { orgId: string; name: string; category: Category | null; votes: number }[]; categories: Record<Category | 'none', number> };

async function breakdownOf(ctx: StaffContext, ideaId: string): Promise<VoteBreakdown> {
  const rows = await withActor(ctx.actor, (tx) => votesByOrgTx(tx, ideaId));
  const orgs = await orgSummaries(ctx, rows.map((row) => row.orgId));
  const categories: Record<Category | 'none', number> = { A: 0, B: 0, C: 0, D: 0, none: 0 };
  const out = rows.map((row) => {
    const org = orgs.get(row.orgId);
    const category = org?.category ?? null;
    categories[category ?? 'none'] += row.votes;
    return { orgId: row.orgId, name: org?.name ?? '', category, votes: row.votes };
  });
  return { orgs: out, categories };
}

/** Разбивка голосов идеи по организациям и категориям A-D (FR-IDEA-15): только product и admin. */
export async function voteBreakdown(ctx: StaffContext, input: unknown): Promise<VoteBreakdown> {
  if (!isModerator(ctx)) throw new HdiError('forbidden');
  const { number } = parseInput(z.strictObject({ number: ideaNumber }), input);
  const detail = await withActor(ctx.actor, (tx) => staffDetailTx(tx, number));
  if (!detail) throw new HdiError('not_found');
  return breakdownOf(ctx, detail.idea.ideaId);
}

export type StaffIdeaCard = {
  ideaId: string;
  number: number;
  status: IdeaStatus;
  authorName: string;
  orgId: string;
  /** Организация автора: сотрудникам всегда (решение 7). */
  orgName: string;
  showOrg: boolean;
  moduleId: string | null;
  voteCount: number;
  orgCount: number;
  commentCount: number;
  declineReason: string | null;
  findingsChecked: boolean;
  publishedOn: Date | null;
  createdOn: Date;
  mergedInto: number | null;
  selectedCycle: string | null;
  releasedIn: string | null;
  releasedOn: string | null;
  texts: StaffText[];
  /** Виды находок проверки текста в оригинале (решение 9). */
  findings: FindingKind[];
  attachments: { attachmentId: string; fileName: string; mime: string; scanStatus: string }[];
  canModerate: boolean;
  /** Переходы, доступные модератору из текущего статуса (решение 19). */
  transitions: IdeaStatus[];
  /** Разбивка только у product и admin (решение 24), у остальных null. */
  breakdown: VoteBreakdown | null;
};

/** Карточка идеи на рабочем месте. Несуществующая: null. */
export async function staffIdeaCard(ctx: StaffContext, input: unknown): Promise<StaffIdeaCard | null> {
  const { number } = parseInput(z.strictObject({ number: ideaNumber }), input);
  const detail = await withActor(ctx.actor, (tx) => staffDetailTx(tx, number));
  if (!detail) return null;
  const { idea } = detail;
  const moderator = isModerator(ctx);
  const original = detail.texts.find((t) => t.status === 'original');
  const findings = original ? [...new Set([...findInText(original.title), ...findInText(original.body)].map((hit) => hit.kind))] : [];
  const org = (await orgSummaries(ctx, [idea.orgId])).get(idea.orgId);
  return {
    ideaId: idea.ideaId,
    number: idea.number,
    status: idea.status,
    authorName: idea.authorName,
    orgId: idea.orgId,
    orgName: org?.name ?? '',
    showOrg: idea.showOrg,
    moduleId: idea.moduleId,
    voteCount: idea.voteCount,
    orgCount: idea.orgCount,
    commentCount: idea.commentCount,
    declineReason: idea.declineReason,
    findingsChecked: idea.findingsChecked,
    publishedOn: idea.publishedOn,
    createdOn: idea.createdOn,
    mergedInto: detail.mergedInto,
    selectedCycle: idea.selectedCycle,
    releasedIn: idea.releasedIn,
    releasedOn: idea.releasedOn,
    texts: detail.texts,
    findings,
    attachments: detail.attachments,
    canModerate: moderator,
    transitions: moderator ? IDEA_STATUSES.filter((to) => transitionBy(idea.status, to) === 'moderator') : [],
    breakdown: moderator ? await breakdownOf(ctx, idea.ideaId) : null,
  };
}
