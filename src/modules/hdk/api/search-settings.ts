import 'server-only';
import * as z from 'zod';
import { withActor } from '@/db/with-actor';
import {
  curationSchema,
  FRESH_SIGN_IN_SEC,
  isFresh,
  readSetting,
  SEARCH_SETTING_CODES,
  SEARCH_SETTINGS_LIMITS,
  type StaffContext,
  stemPairsSchema,
  synonymSetsSchema,
  writeAudit,
  writeSettingTx,
} from '@/modules/hdc/api';
import { HdkError } from '../error';

// Модуль hdk, слой api: синонимы, словарь узбекского и курирование решений (план W6, задача 9; ответ владельца 0070,
// пункт 4: ведёт администратор поддержки на странице настроек). Текст построчно, как в поле страницы:
//   синонимы:   "склад, ombor, warehouse" (все слова равны) или "накладная => yuk xati, invoice" (запрос слева находит
//               слова справа);
//   словарь:    "to'lovlar = to'lov" (слово и его корень);
//   курирование: "накладная | 1042 | 1" (запрос, номер решения KB, место 1-10).
// Администратор со входом не старше 15 минут, запись с аудитом (writeSettingTx), в Typesense набор уходит задачей
// search.sync (строка очереди config ставит триггер). Неверная строка называется номером, ничего не сохраняется.

export type SearchSettingKind = 'synonyms' | 'stems' | 'curation';
export type SearchSettingsText = Record<SearchSettingKind, string>;

const input = z.strictObject({ kind: z.enum(['synonyms', 'stems', 'curation']), text: z.string().max(100_000) });

function requireAdmin(ctx: StaffContext): void {
  if (ctx?.actor?.type !== 'staff' || ctx.actor.staffRole !== 'admin') throw new HdkError('forbidden');
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((l) => l.line.length > 0 && !l.line.startsWith('#'));
const words = (part: string) =>
  part
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);

type Parsed = { ok: true; value: unknown } | { ok: false; line: number };

function parse(kind: SearchSettingKind, text: string): Parsed {
  const rows = lines(text);
  if (kind === 'synonyms') {
    const sets = [];
    for (const { line, number } of rows) {
      const [left, right] = line.split('=>');
      const set = right !== undefined ? { id: `s${number}`, root: left!.trim(), words: words(right) } : { id: `s${number}`, words: words(left!) };
      const ok = synonymSetsSchema.shape.sets.element.safeParse(set);
      if (!ok.success || (!ok.data.root && ok.data.words.length < 2)) return { ok: false, line: number };
      sets.push(ok.data);
    }
    const all = synonymSetsSchema.safeParse({ sets });
    return all.success ? { ok: true, value: all.data } : { ok: false, line: rows[SEARCH_SETTINGS_LIMITS.synonymSets]?.number ?? 1 };
  }
  if (kind === 'stems') {
    const pairs = [];
    for (const { line, number } of rows) {
      const [word, root, extra] = line.split('=');
      const ok = stemPairsSchema.shape.pairs.element.safeParse({ word: word?.trim(), root: root?.trim() });
      if (!ok.success || extra !== undefined) return { ok: false, line: number };
      pairs.push(ok.data);
    }
    const all = stemPairsSchema.safeParse({ pairs });
    return all.success ? { ok: true, value: all.data } : { ok: false, line: rows[SEARCH_SETTINGS_LIMITS.stems]?.number ?? 1 };
  }
  const rules = [];
  for (const { line, number } of rows) {
    const [query, article, position, extra] = line.split('|').map((p) => p.trim());
    const ok = curationSchema.shape.rules.element.safeParse({
      id: `r${number}`,
      query,
      match: 'contains',
      articleNumber: Number((article ?? '').replace(/^KB-?/i, '')),
      position: Number(position ?? '1'),
    });
    if (!ok.success || extra !== undefined) return { ok: false, line: number };
    rules.push(ok.data);
  }
  const all = curationSchema.safeParse({ rules });
  return all.success ? { ok: true, value: all.data } : { ok: false, line: rows[SEARCH_SETTINGS_LIMITS.curationRules]?.number ?? 1 };
}

/** Текст для полей страницы из сохранённых значений. */
export async function searchSettingsText(ctx: StaffContext): Promise<SearchSettingsText> {
  requireAdmin(ctx);
  const [syn, stems, cur] = await Promise.all([readSetting(SEARCH_SETTING_CODES.synonyms), readSetting(SEARCH_SETTING_CODES.stems), readSetting(SEARCH_SETTING_CODES.curation)]);
  const s = synonymSetsSchema.safeParse(syn ?? { sets: [] });
  const p = stemPairsSchema.safeParse(stems ?? { pairs: [] });
  const c = curationSchema.safeParse(cur ?? { rules: [] });
  return {
    synonyms: s.success ? s.data.sets.map((set) => (set.root ? `${set.root} => ${set.words.join(', ')}` : set.words.join(', '))).join('\n') : '',
    stems: p.success ? p.data.pairs.map((pair) => `${pair.word} = ${pair.root}`).join('\n') : '',
    curation: c.success ? c.data.rules.map((rule) => `${rule.query} | ${rule.articleNumber} | ${rule.position}`).join('\n') : '',
  };
}

/** Сохраняет один набор целиком. Неверная строка: номер строки, ничего не сохраняется. */
export async function saveSearchSetting(ctx: StaffContext, value: unknown): Promise<{ ok: true } | { ok: false; line: number }> {
  requireAdmin(ctx);
  if (!isFresh(ctx, new Date(), FRESH_SIGN_IN_SEC)) throw new HdkError('stale_session');
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HdkError('invalid_input');
  const result = parse(parsed.data.kind, parsed.data.text);
  if (!result.ok) return result;
  const code = SEARCH_SETTING_CODES[parsed.data.kind];
  const value_ = result.value as { sets?: unknown[]; pairs?: unknown[]; rules?: unknown[] };
  const items = (value_.sets ?? value_.pairs ?? value_.rules ?? []).length;
  // Набор целиком может быть больше предела записи журнала (4000 знаков): в журнал код и число записей, сам набор
  // остаётся в hdc_settings с отметкой, кто и когда его изменил.
  await withActor(ctx.actor, async (tx) => {
    await writeSettingTx(tx, code, result.value, { audit: false });
    await writeAudit(tx, { action: 'settings.changed', objectType: 'setting', objectId: code, diff: { code, items } });
  });
  return { ok: true };
}
