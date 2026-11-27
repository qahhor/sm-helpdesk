import { expect, test } from 'vitest';
import { candidateMergeDecision, distinctOrgCount, returnsFromRejected } from '@/modules/hda/candidates/merge';

// Склейка кандидатов в решения (ТЗ FR-CAND-02, 03, 05, строка таблицы прослеживаемости "Модульные тесты склейки";
// план M5c, задача 9, решение 28): чистые функции решения на границах порогов.

const thresholds = { published: 0.88, merge: 0.85 };

test('похоже на опубликованное решение не ниже порога: кандидата нет, решению "пригодилось сотрудникам"', () => {
  expect(candidateMergeDecision({ publishedBest: { articleId: 'a1', similarity: 0.88 }, candidateBest: { id: 'c1', status: 'new', similarity: 0.99 }, thresholds })).toEqual({ kind: 'useful', articleId: 'a1' });
  expect(candidateMergeDecision({ publishedBest: { articleId: 'a1', similarity: 0.95 }, candidateBest: null, thresholds })).toEqual({ kind: 'useful', articleId: 'a1' });
});

test('чуть ниже порога решения: смотрим кандидатов', () => {
  expect(candidateMergeDecision({ publishedBest: { articleId: 'a1', similarity: 0.8799 }, candidateBest: { id: 'c1', status: 'new', similarity: 0.85 }, thresholds })).toEqual({ kind: 'merge', candidateId: 'c1' });
});

test('склейка с новым и отклонённым кандидатом не ниже порога склейки', () => {
  expect(candidateMergeDecision({ publishedBest: null, candidateBest: { id: 'c2', status: 'rejected', similarity: 0.851 }, thresholds })).toEqual({ kind: 'merge', candidateId: 'c2' });
});

test('ниже порога склейки и без похожих: новый кандидат', () => {
  expect(candidateMergeDecision({ publishedBest: null, candidateBest: { id: 'c1', status: 'new', similarity: 0.8499 }, thresholds })).toEqual({ kind: 'create' });
  expect(candidateMergeDecision({ publishedBest: null, candidateBest: null, thresholds })).toEqual({ kind: 'create' });
  expect(candidateMergeDecision({ publishedBest: { articleId: 'a1', similarity: 0.5 }, candidateBest: null, thresholds })).toEqual({ kind: 'create' });
});

test('отклонённый кандидат возвращается ровно на пятом новом источнике', () => {
  expect(returnsFromRejected({ sourceCount: 6, rejectedAtSourceCount: 2 })).toBe(false);
  expect(returnsFromRejected({ sourceCount: 7, rejectedAtSourceCount: 2 })).toBe(true);
  expect(returnsFromRejected({ sourceCount: 1, rejectedAtSourceCount: null })).toBe(false);
});

test('org_count считается по разным организациям, а не по источникам', () => {
  expect(distinctOrgCount([{ orgId: 'o1' }, { orgId: 'o1' }, { orgId: 'o2' }])).toBe(2);
  expect(distinctOrgCount([])).toBe(0);
});
