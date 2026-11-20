import { Button } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { requestLoginLinkAction } from './actions';

export type LoginLinkLabels = { email: string; submit: string };

/** Адрес для ссылки входа. Обычная форма: работает и без скриптов. */
export function LoginLinkForm({ next, labels }: { next: string; labels: LoginLinkLabels }) {
  return (
    <form action={requestLoginLinkAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <FormField name="email" label={labels.email} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required />
      <Button type="submit" variant="secondary">
        {labels.submit}
      </Button>
    </form>
  );
}
