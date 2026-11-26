import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getPolicyVersion } from "@/modules/hdc/api";
import {
  needsPolicyNotice,
  requireClientActor,
  safeReturnPath,
  telegramEnabled,
} from "@/modules/hdu/api";
import { Alert } from "@/ui/components/alert";
import { Button, buttonVariants } from "@/ui/components/button";
import { Card, CardContent, CardHeader } from "@/ui/components/card";
import { FormField } from "@/ui/components/form-field";
import { ReauthNotice } from "@/ui/components/ReauthNotice";
import {
  acknowledgePolicyAction,
  sendWelcomeLinkAction,
  skipWelcomeAction,
  welcomeReauthAction,
} from "./actions";
import { firstParam } from "@/lib/search-params";

// Шаг первого входа (FR-ID-07): после входа через Smartup портал один раз предлагает указать email.
// У большинства пользователей Smartup адреса нет (решение 89 ТЗ), поэтому шаг можно пропустить.
// Строка о политике обработки данных: при первом входе вместе с шагом, после выхода новой версии
// отдельным коротким шагом (раздел 14.6 ТЗ, решение 0017). Пока политика выключена, строки нет.
export default async function WelcomePage({
  searchParams,
}: PageProps<"/[locale]/welcome">) {
  const client = await requireClientActor();
  const params = await searchParams;
  const locale = await getLocale();
  const next = safeReturnPath(firstParam(params.next), `/${locale}`);
  const sent = firstParam(params.sent) === "1";
  const policyVersion = await getPolicyVersion();
  const policyDue = needsPolicyNotice(client.user, policyVersion);
  const firstStep = !client.user.onboarded && !client.user.hasVerifiedEmail;
  if (!sent && !firstStep && !policyDue) redirect(next);

  const t = await getTranslations("auth.welcome");
  const policyLink = (chunks: React.ReactNode) => (
    <Link
      href="/legal/privacy"
      target="_blank"
      rel="noopener"
      className="font-medium text-link underline-offset-4 hover:underline"
    >
      {chunks}
    </Link>
  );

  if (!sent && !firstStep)
    return (
      <Card>
        <CardHeader>
          <h1 className="text-xl font-semibold">{t("policyTitle")}</h1>
          <p className="text-secondary-foreground">
            {t.rich("policyText", { link: policyLink })}
          </p>
        </CardHeader>
        <CardContent>
          <form action={acknowledgePolicyAction}>
            <input type="hidden" name="next" value={next} />
            <Button type="submit" className="w-full">
              {t("policyAcknowledge")}
            </Button>
          </form>
        </CardContent>
      </Card>
    );

  const error = firstParam(params.error);
  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">
          {t("title", { name: client.user.name })}
        </h1>
        {!sent && <p className="text-secondary-foreground">{t("text")}</p>}
        {!sent && policyVersion && (
          <p className="text-sm text-secondary-foreground">
            {t.rich("policyLine", { link: policyLink })}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sent ? (
          <>
            <Alert tone="success">{t("sent")}</Alert>
            <a href={next} className={buttonVariants()}>
              {t("continue")}
            </a>
          </>
        ) : (
          <>
            {error === "stale_session" && (
              <ReauthNotice
                text={t("errors.stale")}
                label={t("reauth")}
                next={next}
                action={welcomeReauthAction}
              />
            )}
            <form className="flex flex-col gap-4">
              <input type="hidden" name="next" value={next} />
              {error && error !== "stale_session" && (
                <Alert tone="danger">
                  {t(
                    error === "rate_limited"
                      ? "errors.rateLimited"
                      : "errors.invalid",
                  )}
                </Alert>
              )}
              <FormField
                name="email"
                label={t("email")}
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={254}
                defaultValue={client.user.claimedEmail ?? ""}
              />
              <Button type="submit" formAction={sendWelcomeLinkAction}>
                {t("send")}
              </Button>
              {telegramEnabled() && (
                // Бот открывается в новой вкладке: шаг остаётся открытым, его можно завершить после привязки.
                <a
                  href={`/${locale}/settings/telegram`}
                  target="_blank"
                  rel="noopener"
                  className={buttonVariants({ variant: "secondary" })}
                >
                  {t("telegram")}
                </a>
              )}
              {/* Пропуск не требует адреса: проверка поля браузером здесь не нужна. */}
              <Button
                type="submit"
                variant="secondary"
                formAction={skipWelcomeAction}
                formNoValidate
              >
                {t("skip")}
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
