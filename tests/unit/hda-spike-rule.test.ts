import { describe, expect, test } from 'vitest';
import { spikeDecision } from '@/modules/hda/agent/spikes';

// Правило всплеска сигнатуры (веха M8b, задача 8; FR-AGT-11; план M8b, решение 25): не меньше порога разных
// организаций за окно, нет активной проблемы или черновика с этой сигнатурой, не было всплеска этой сигнатуры за 24 часа.

const now = new Date('2026-11-27T10:00:00Z');
const base = { orgCount: 3, threshold: 3, activeProblem: false, lastSpikeOn: null, now };

describe('spikeDecision', () => {
  test('порог достигнут: всплеск; на единицу меньше: нет', () => {
    expect(spikeDecision(base)).toBe('spike');
    expect(spikeDecision({ ...base, orgCount: 2 })).toBe('skip');
    expect(spikeDecision({ ...base, orgCount: 10, threshold: 10 })).toBe('spike');
  });
  test('активная проблема или черновик с этой сигнатурой: нет всплеска', () => {
    expect(spikeDecision({ ...base, orgCount: 50, activeProblem: true })).toBe('skip');
  });
  test('всплеск этой сигнатуры за последние 24 часа: нет; ровно 24 часа назад и раньше: да', () => {
    expect(spikeDecision({ ...base, lastSpikeOn: new Date(now.getTime() - 23 * 3_600_000) })).toBe('skip');
    expect(spikeDecision({ ...base, lastSpikeOn: new Date(now.getTime() - 24 * 3_600_000 + 1) })).toBe('skip');
    expect(spikeDecision({ ...base, lastSpikeOn: new Date(now.getTime() - 24 * 3_600_000) })).toBe('spike');
    expect(spikeDecision({ ...base, lastSpikeOn: new Date(now.getTime() - 48 * 3_600_000) })).toBe('spike');
  });
});
