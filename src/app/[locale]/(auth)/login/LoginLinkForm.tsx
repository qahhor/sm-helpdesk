import {
  BotCheckField,
  type BotCheckProps,
} from "@/ui/components/BotCheckField";
import { BotCheckRefresh } from "@/ui/components/BotCheckRefresh";
import { Button } from "@/ui/components/button";
import { FormField } from "@/ui/components/form-field";
import { requestLoginLinkAction } from "./actions";

export type LoginLinkLabels = { email: string; submit: string };

/** Адрес для ссылки входа. Обычная форма: работает и без скриптов. */
export function LoginLinkForm({
  next,
  labels,
  botCheck,
}: {
  next: string;
  labels: LoginLinkLabels;
  botCheck: BotCheckProps;
}) {
  return (
    <form action={requestLoginLinkAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <FormField
        name="email"
        label={labels.email}
        type="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={254}
        required
      />
      <BotCheckField {...botCheck} />
      {/* Одноразовый код страницы новый после каждого ответа: виджет получает свежий токен. */}
      {botCheck.siteKey && <BotCheckRefresh resetKey={botCheck.nonce} />}
      <Button type="submit" variant="secondary">
        {labels.submit}
      </Button>
    </form>
  );
}
