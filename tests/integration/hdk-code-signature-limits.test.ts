import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setCodeMatchProbeForTests } from '@/modules/hda/api/code-match';
import { consumeRateLimit, rateKey } from '@/modules/hdc/api';
import { RATE_RULES } from '@/modules/hdc/pref';
import { suggestForWidget } from '@/modules/hdk/api/suggest';
import { publicProblemForText } from '@/modules/hdp/api/client';
import { clientCtx } from './helpers/auth';
import { pools } from './helpers/db';
import { type Fixture, seedTwoOrgs } from './isolation/fixture';

// Независимая проверка вехи M8c, находка C1 (решение 0134): сопоставление с шаблонами знаний из кода идёт в базе и
// стоит дороже остальной подсказки, поэтому предел запросов проверяется до него. Вызовы считает проба модуля hda.

const calls = { n: 0 };
let f: Fixture;

beforeEach(async () => {
  f = await seedTwoOrgs();
  await pools.root.query(`delete from hdc_rate_limits where code like 'kb-%' or code like 'problem-%'`);
  calls.n = 0;
  setCodeMatchProbeForTests(() => void (calls.n += 1));
});
afterEach(() => setCodeMatchProbeForTests(null));

const text = 'ORA-20001: Недостаточно остатка товара Молоко на складе Основной';

test('C1: подсказка в виджете сверх предела не сопоставляет текст с шаблонами', async () => {
  const ctx = await clientCtx(f.aUser);
  for (let i = 0; i < RATE_RULES.kbSuggestPerUser.limit; i++) await consumeRateLimit(rateKey('kb-suggest:user', ctx.actor.userId), RATE_RULES.kbSuggestPerUser);
  const out = await suggestForWidget(ctx, { text, sessionId: randomUUID(), locale: 'ru', errorCode: 'ORA-20001', errorText: text });
  expect(out).toEqual({ items: [], limited: true });
  expect(calls.n).toBe(0);
});

test('C1: баннер известной проблемы сверх предела не сопоставляет текст с шаблонами', async () => {
  const ctx = await clientCtx(f.aUser);
  expect(await publicProblemForText(ctx.actor, { text, locale: 'ru' })).toBeNull();
  expect(calls.n).toBe(1);
  for (let i = 0; i < RATE_RULES.kbSuggestPerUser.limit; i++) await consumeRateLimit(rateKey('problem-banner:user', ctx.actor.userId), RATE_RULES.kbSuggestPerUser);
  expect(await publicProblemForText(ctx.actor, { text, locale: 'ru' })).toBeNull();
  expect(calls.n).toBe(1);
});
