import { getTranslations } from 'next-intl/server';
import { TIMINGS_DEFAULT, type Timings } from '@/modules/hdt/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { saveTimingsAction } from './actions';

// Сроки напоминаний и автозакрытия (решение 24): четыре поля в рабочих днях от 1 до 30, значения по умолчанию подписаны.

const FIELDS = ['waitingReminderDays', 'autocloseResolvedDays', 'autocloseWaitingDays', 'updateIntervalDays'] as const;

export async function TimingsForm({ timings }: { timings: Timings }) {
  const t = await getTranslations('agent.settings.mail.timings');
  return (
    <section aria-labelledby="mail-timings" className="flex flex-col gap-3">
      <h2 id="mail-timings" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-secondary-foreground">{t('intro')}</p>
      <Card>
        <CardContent className="pt-6">
          <form action={saveTimingsAction} className="flex flex-col gap-3">
            {FIELDS.map((field) => (
              <div key={field} className="flex flex-col gap-1">
                <Label htmlFor={`timing-${field}`}>{t(field)}</Label>
                <Input
                  id={`timing-${field}`}
                  name={field}
                  type="number"
                  min={1}
                  max={30}
                  required
                  defaultValue={timings[field]}
                  className="max-w-32"
                  aria-describedby={`timing-${field}-hint`}
                />
                <p id={`timing-${field}-hint`} className="text-sm text-secondary-foreground">
                  {t('default', { days: TIMINGS_DEFAULT[field] })}
                </p>
              </div>
            ))}
            <Button type="submit" className="self-start">
              {t('save')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
