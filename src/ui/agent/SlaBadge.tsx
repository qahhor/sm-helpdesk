import { StatusLabel, type StatusTone } from '@/ui/components/StatusLabel';

// Срок SLA в очереди и в обращении (UX-A-08): три состояния текстом и цветом. Цвета из токенов меток.

export type SlaPhase = 'calm' | 'soon' | 'breached';

const TONE: Record<SlaPhase, StatusTone> = { calm: 'gray', soon: 'orange', breached: 'danger' };

/** Ключ подписи по рабочим минутам до срока: "41 мин", "2 ч", "нарушен". Часы округляются вниз. */
export function slaLabelKey(minutesLeft: number | null): { key: 'minutes' | 'hours' | 'breached' | 'none'; value: number } {
  if (minutesLeft === null) return { key: 'none', value: 0 };
  if (minutesLeft <= 0) return { key: 'breached', value: 0 };
  if (minutesLeft < 60) return { key: 'minutes', value: minutesLeft };
  return { key: 'hours', value: Math.floor(minutesLeft / 60) };
}

export function SlaBadge({ phase, label }: { phase: SlaPhase; label: string }) {
  return (
    <span data-sla={phase}>
      <StatusLabel tone={TONE[phase]}>{label}</StatusLabel>
    </span>
  );
}
