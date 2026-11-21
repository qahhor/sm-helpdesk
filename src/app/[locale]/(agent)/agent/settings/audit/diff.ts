import type { AuditRow } from '@/modules/hdc/api';

// Изменения записи журнала строками текста: "поле: было → стало" или "поле: значение".
// Поля и значения-коды переводит label (messages: agent.settings.audit.diffKeys и diffValues),
// неизвестное остаётся как есть (проверка main, Q14). Разметки из данных нет: только текст.

type Label = (raw: string) => string;

function plain(value: unknown, label: Label, none: string): string {
  if (value === null || value === undefined) return none;
  if (Array.isArray(value)) return value.map((item) => plain(item, label, none)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return label(String(value));
}

export function diffLines(diff: AuditRow['diff'], label: Label, none: string): string[] {
  if (!diff) return [];
  return Object.entries(diff).map(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'from' in value && 'to' in value) {
      const change = value as { from: unknown; to: unknown };
      return `${label(key)}: ${plain(change.from, label, none)} → ${plain(change.to, label, none)}`;
    }
    return `${label(key)}: ${plain(value, label, none)}`;
  });
}
