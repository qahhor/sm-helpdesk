import { Button } from '@/ui/components/button';
import { FormField } from '@/ui/components/form-field';
import { rememberServerAction } from './actions';

export type ServerAddressLabels = { address: string; hint: string; submit: string };

/** Адрес Smartup клиента выделенного сервера. Обычная форма: работает и без скриптов. */
export function ServerAddressForm({ next, labels }: { next: string; labels: ServerAddressLabels }) {
  return (
    <form action={rememberServerAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <FormField
        name="address"
        label={labels.address}
        hint={labels.hint}
        inputMode="url"
        autoComplete="url"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={500}
        required
      />
      <Button type="submit" variant="secondary">
        {labels.submit}
      </Button>
    </form>
  );
}
