import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';

// Какие письма получать (FR-NT-04, решение 6 вехи M4). Письма о своих обращениях отмечены и не выключаются:
// у такой галочки нет имени, форма её не отправляет, а схема на сервере не принимает такого поля.

export type PrefOption = { name: string; label: string; checked: boolean };

export function NotificationPrefsForm({
  title,
  intro,
  locked,
  options,
  save,
  saveLabel,
  savedLabel,
  saved,
}: {
  title: string;
  intro: string;
  locked: { label: string; hint: string } | null;
  options: PrefOption[];
  save: (formData: FormData) => Promise<void>;
  saveLabel: string;
  savedLabel: string;
  saved: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-secondary-foreground">{intro}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {saved && <Alert tone="success">{savedLabel}</Alert>}
        <form action={save} className="flex flex-col gap-3">
          {locked && (
            <label className="flex items-start gap-3">
              <input type="checkbox" checked disabled aria-describedby="pref-locked-hint" className="mt-1 size-5 accent-primary" />
              <span className="flex flex-col">
                <span>{locked.label}</span>
                <span id="pref-locked-hint" className="text-sm text-secondary-foreground">
                  {locked.hint}
                </span>
              </span>
            </label>
          )}
          {options.map((option) => (
            <label key={option.name} className="flex items-start gap-3">
              <input type="checkbox" name={option.name} defaultChecked={option.checked} className="mt-1 size-5 accent-primary" />
              <span>{option.label}</span>
            </label>
          ))}
          <Button type="submit" variant="secondary" className="self-start">
            {saveLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
