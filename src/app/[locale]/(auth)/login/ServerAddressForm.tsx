import {
  BotCheckField,
  type BotCheckProps,
} from "@/ui/components/BotCheckField";
import { BotCheckRefresh } from "@/ui/components/BotCheckRefresh";
import { Button } from "@/ui/components/button";
import { FormField } from "@/ui/components/form-field";
import { rememberServerAction } from "./actions";

export type ServerAddressLabels = {
  address: string;
  hint: string;
  submit: string;
};

/** Адрес Smartup клиента выделенного сервера. Обычная форма: работает и без скриптов. */
export function ServerAddressForm({
  next,
  labels,
  botCheck,
}: {
  next: string;
  labels: ServerAddressLabels;
  botCheck: BotCheckProps;
}) {
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
      <BotCheckField {...botCheck} />
      {botCheck.siteKey && <BotCheckRefresh resetKey={botCheck.nonce} />}
      <Button type="submit" variant="secondary">
        {labels.submit}
      </Button>
    </form>
  );
}
