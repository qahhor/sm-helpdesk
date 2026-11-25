import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { kbArticles, kbErrorSignatures, kbSignatureOrgs } from '../schema';

// Модуль hdk, слой core: сигнатуры ошибок (план M5, задача 8; ТЗ 11.5, FR-SOL-07, 12; решения 7 и 8).
// Встречи сигнатуры и её организации пишет система; привязку решения меняют роли черновиков (политики RLS).

/** Предел примера кода и текста (ограничение hdk_error_signatures_c3). */
const SAMPLE_CODE_MAX = 80;
const SAMPLE_MESSAGE_MAX = 300;

export type SignatureSample = { signature: string; code: string; sample: string };

const clipSample = (input: SignatureSample) => ({
  sampleCode: input.code ? input.code.slice(0, SAMPLE_CODE_MAX) : null,
  sampleMessage: input.sample ? input.sample.slice(0, SAMPLE_MESSAGE_MAX) : null,
});

/**
 * Встреча сигнатуры в новом обращении (решение 8): строка сигнатуры (пример с первой встречи), организация, число
 * различных организаций и встреч. Транзакция системы.
 */
export async function noteSignatureTx(tx: Tx, input: SignatureSample & { orgId: string; moduleId: string | null }): Promise<string> {
  const sample = clipSample(input);
  const [row] = await tx
    .insert(kbErrorSignatures)
    .values({ signature: input.signature, moduleId: input.moduleId, ...sample, occurrences: 1, lastSeenOn: sql`now()` })
    .onConflictDoUpdate({
      target: kbErrorSignatures.signature,
      set: {
        occurrences: sql`${kbErrorSignatures.occurrences} + 1`,
        lastSeenOn: sql`now()`,
        moduleId: sql`coalesce(${kbErrorSignatures.moduleId}, excluded.module_id)`,
        sampleCode: sql`coalesce(${kbErrorSignatures.sampleCode}, excluded.sample_code)`,
        sampleMessage: sql`coalesce(${kbErrorSignatures.sampleMessage}, excluded.sample_message)`,
      },
    })
    .returning({ signatureId: kbErrorSignatures.signatureId });
  const signatureId = (row as { signatureId: string }).signatureId;
  await tx
    .insert(kbSignatureOrgs)
    .values({ signatureId, orgId: input.orgId })
    .onConflictDoUpdate({ target: [kbSignatureOrgs.signatureId, kbSignatureOrgs.orgId], set: { lastSeenOn: sql`now()` } });
  await tx
    .update(kbErrorSignatures)
    .set({ orgCount: sql`(select count(*) from ${kbSignatureOrgs} where ${kbSignatureOrgs.signatureId} = ${signatureId})::int` })
    .where(eq(kbErrorSignatures.signatureId, signatureId));
  return signatureId;
}

export type BindResult = { status: 'bound'; signatureId: string; signature: string; changed: boolean } | { status: 'taken'; number: number } | { status: 'not_found' };

/**
 * Привязка сигнатуры к решению. Сигнатура уже у другого решения: не перехватывается, итог называет его номер.
 * Строки ещё нет (ошибка не встречалась в обращениях): создаётся с примером, который ввёл сотрудник.
 */
export async function bindSignatureTx(tx: Tx, articleId: string, target: { signatureId: string } | SignatureSample): Promise<BindResult> {
  const filter = 'signatureId' in target ? eq(kbErrorSignatures.signatureId, target.signatureId) : eq(kbErrorSignatures.signature, target.signature);
  let [row] = await tx
    .select({ signatureId: kbErrorSignatures.signatureId, signature: kbErrorSignatures.signature, articleId: kbErrorSignatures.articleId })
    .from(kbErrorSignatures)
    .where(filter)
    .limit(1)
    .for('update');
  if (!row && 'signatureId' in target) return { status: 'not_found' };
  if (!row && !('signatureId' in target)) {
    [row] = await tx
      .insert(kbErrorSignatures)
      .values({ signature: target.signature, articleId, ...clipSample(target) })
      .onConflictDoNothing()
      .returning({ signatureId: kbErrorSignatures.signatureId, signature: kbErrorSignatures.signature, articleId: kbErrorSignatures.articleId });
    // Ту же сигнатуру одновременно завёл кто-то ещё: повтор привязки прочитает его строку.
    if (!row) return bindSignatureTx(tx, articleId, target);
    return { status: 'bound', signatureId: row.signatureId, signature: row.signature, changed: true };
  }
  const found = row as { signatureId: string; signature: string; articleId: string | null };
  if (found.articleId === articleId) return { status: 'bound', signatureId: found.signatureId, signature: found.signature, changed: false };
  if (found.articleId !== null) {
    const [other] = await tx.select({ number: kbArticles.number }).from(kbArticles).where(eq(kbArticles.articleId, found.articleId)).limit(1);
    return { status: 'taken', number: other?.number ?? 0 };
  }
  await tx.update(kbErrorSignatures).set({ articleId }).where(eq(kbErrorSignatures.signatureId, found.signatureId));
  return { status: 'bound', signatureId: found.signatureId, signature: found.signature, changed: true };
}

/** Снимает привязку сигнатуры к решению. Сигнатура другого решения не трогается. */
export async function unbindSignatureTx(tx: Tx, articleId: string, signatureId: string): Promise<string | null> {
  const [row] = await tx
    .update(kbErrorSignatures)
    .set({ articleId: null })
    .where(and(eq(kbErrorSignatures.signatureId, signatureId), eq(kbErrorSignatures.articleId, articleId)))
    .returning({ signature: kbErrorSignatures.signature });
  return row?.signature ?? null;
}

export type SignatureRow = {
  signatureId: string;
  sampleCode: string | null;
  sampleMessage: string | null;
  orgCount: number;
  occurrences: number;
  lastSeenOn: Date | null;
};

const signatureColumns = {
  signatureId: kbErrorSignatures.signatureId,
  sampleCode: kbErrorSignatures.sampleCode,
  sampleMessage: kbErrorSignatures.sampleMessage,
  orgCount: kbErrorSignatures.orgCount,
  occurrences: kbErrorSignatures.occurrences,
  lastSeenOn: kbErrorSignatures.lastSeenOn,
};

/** Сигнатуры решения: самые частые первыми. */
export async function articleSignaturesTx(tx: Tx, articleId: string): Promise<SignatureRow[]> {
  return tx
    .select(signatureColumns)
    .from(kbErrorSignatures)
    .where(eq(kbErrorSignatures.articleId, articleId))
    .orderBy(desc(kbErrorSignatures.orgCount), desc(kbErrorSignatures.occurrences), kbErrorSignatures.signatureId);
}

/**
 * Частые сигнатуры без действующего решения (FR-MET-05): решения нет или оно в архиве, встречалась в периоде.
 * Порядок: больше организаций, затем больше встреч.
 */
export async function unsolvedSignaturesTx(tx: Tx, input: { from: Date; to: Date; limit: number }): Promise<SignatureRow[]> {
  return tx
    .select(signatureColumns)
    .from(kbErrorSignatures)
    .leftJoin(kbArticles, eq(kbArticles.articleId, kbErrorSignatures.articleId))
    .where(
      and(
        sql`(${kbErrorSignatures.articleId} is null or ${kbArticles.status} = 'archived')`,
        sql`${kbErrorSignatures.occurrences} > 0`,
        sql`${kbErrorSignatures.lastSeenOn} >= ${input.from.toISOString()}::timestamptz`,
        sql`${kbErrorSignatures.lastSeenOn} < ${input.to.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(kbErrorSignatures.orgCount), desc(kbErrorSignatures.occurrences), kbErrorSignatures.signatureId)
    .limit(input.limit);
}
