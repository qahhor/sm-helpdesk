import { SPIKE_REPEAT_HOURS } from '../pref';

// Правило всплеска сигнатуры (веха M8b, задача 8; FR-AGT-11; план M8b, решение 25). Чистая функция: число разных
// организаций за окно не меньше порога, нет активной проблемы или черновика с этой сигнатурой, не было всплеска этой
// сигнатуры за последние 24 часа.

export type SpikeInput = { orgCount: number; threshold: number; activeProblem: boolean; lastSpikeOn: Date | null; now: Date };

export function spikeDecision(input: SpikeInput): 'spike' | 'skip' {
  if (input.orgCount < input.threshold || input.activeProblem) return 'skip';
  if (input.lastSpikeOn && input.now.getTime() - input.lastSpikeOn.getTime() < SPIKE_REPEAT_HOURS * 3_600_000) return 'skip';
  return 'spike';
}
