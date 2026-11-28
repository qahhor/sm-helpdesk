import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';

// Какие письма получать сотруднику (FR-NT-04, решение 7 вехи M4). Каналы клиента: ClientChannelsForm.

export type PrefOption = { name: string; label: string; checked: boolean };

export function NotificationPrefsForm({
  title,
  intro,
  options,
  save,
  saveLabel,
  savedLabel,
  saved,
}: {
  title: string;
  intro: string;
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
          {options.map((option) => (
            <label key={option.name} className="flex min-h-11 items-center gap-3">
              <input type="checkbox" name={option.name} defaultChecked={option.checked} className="size-5 shrink-0 accent-primary" />
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
