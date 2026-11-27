import { Link } from '@/i18n/navigation';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { createFromSpikeAction } from './actions';

// Блок "Всплески сигнатур" на странице известных проблем (веха M8b, задача 8; FR-AGT-11; план M8b, решение 25):
// сигнатура у обращений многих организаций за короткое окно. Видят все сотрудники; "Создать известную проблему"
// работает и без AI-сотрудника, кнопку видит роль ведения проблем.

export type SpikeRow = { spikeId: string; signature: string; orgCount: number; ticketCount: number; windowMinutes: number; detectedOn: string; problemNumber: number | null; problemRef: string | null };

export type SpikesLabels = { title: string; intro: string; counts: (row: SpikeRow) => string; problem: string; create: string; titleLabel: string; defaultTitle: (row: SpikeRow) => string };

export function SpikesBlock({ rows, canWrite, labels }: { rows: SpikeRow[]; canWrite: boolean; labels: SpikesLabels }) {
  if (rows.length === 0) return null;
  return (
    <Card data-testid="signature-spikes">
      <CardHeader>
        <h2 className="text-base font-semibold">{labels.title}</h2>
        <p className="text-sm text-secondary-foreground">{labels.intro}</p>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.spikeId} className="flex flex-col gap-2 rounded-control border border-border p-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <code className="break-all font-mono text-xs" title={row.signature}>
                  {row.signature.slice(0, 8)}
                </code>
                <span>{labels.counts(row)}</span>
              </p>
              {row.problemNumber !== null ? (
                <Link href={`/agent/problems/${row.problemNumber}`} className="text-link underline-offset-2 hover:underline">
                  {labels.problem} {row.problemRef}
                </Link>
              ) : (
                canWrite && (
                  <form action={createFromSpikeAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <input type="hidden" name="spikeId" value={row.spikeId} />
                    <div className="flex flex-1 flex-col gap-1">
                      <Label htmlFor={`spike-title-${row.spikeId}`}>{labels.titleLabel}</Label>
                      <Input id={`spike-title-${row.spikeId}`} name="internalTitle" required maxLength={200} defaultValue={labels.defaultTitle(row)} />
                    </div>
                    <Button type="submit" variant="secondary">
                      {labels.create}
                    </Button>
                  </form>
                )
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
