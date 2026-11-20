"use client";

import { useActionState, useState } from "react";
import { Alert } from "@/ui/components/alert";
import {
  BotCheckField,
  type BotCheckProps,
} from "@/ui/components/BotCheckField";
import { BotCheckRefresh } from "@/ui/components/BotCheckRefresh";
import { Button } from "@/ui/components/button";
import { FormField } from "@/ui/components/form-field";
import { QrCode } from "@/ui/components/QrCode";
import { staffLoginAction, type StaffLoginState } from "./actions";

export type StaffLoginLabels = {
  email: string;
  password: string;
  submit: string;
  codeLabel: string;
  codeHint: string;
  codeSubmit: string;
  enrollTitle: string;
  enrollText: string;
  qrLabel: string;
  secretLabel: string;
  startOver: string;
};

const START: StaffLoginState = { step: "credentials" };

/** Ключ группами по четыре знака: так его проще набрать вручную. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

/**
 * Форма входа сотрудника в три шага: адрес и пароль, затем код. При первом входе вместо шага "код"
 * идёт подключение второго фактора. Работает и без скриптов: это обычная форма с серверным действием.
 */
export function StaffLoginForm({
  next,
  labels,
  botCheck,
}: {
  next: string;
  labels: StaffLoginLabels;
  botCheck: BotCheckProps;
}) {
  const [state, action, pending] = useActionState(staffLoginAction, START);
  // Ключ и рисунок приходят один раз, после пароля. При неверном коде сервер их не повторяет.
  const [enroll, setEnroll] = useState<{
    secret: string;
    qr: boolean[][];
  } | null>(null);
  if (state.secret && state.qr && state.secret !== enroll?.secret)
    setEnroll({ secret: state.secret, qr: state.qr });

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="step" value={state.step} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      {state.step === "credentials" && (
        <>
          <FormField
            name="email"
            type="email"
            label={labels.email}
            autoComplete="username"
            required
            autoFocus
          />
          <FormField
            name="password"
            type="password"
            label={labels.password}
            autoComplete="current-password"
            required
          />
          <BotCheckField {...botCheck} />
          {/* Состояние формы новое после каждого ответа: виджет получает свежий токен для следующей попытки. */}
          {botCheck.siteKey && <BotCheckRefresh resetKey={state} />}
          <Button type="submit" disabled={pending}>
            {labels.submit}
          </Button>
        </>
      )}

      {state.step === "enroll" && enroll && (
        <section aria-labelledby="enroll-title" className="flex flex-col gap-3">
          <h2 id="enroll-title" className="text-lg font-semibold">
            {labels.enrollTitle}
          </h2>
          <p className="text-secondary-foreground">{labels.enrollText}</p>
          <QrCode
            matrix={enroll.qr}
            label={labels.qrLabel}
            className="self-center"
          />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{labels.secretLabel}</span>
            <code
              data-testid="totp-secret"
              className="break-all rounded-control border border-border bg-card-soft px-3 py-2 font-mono text-sm"
            >
              {grouped(enroll.secret)}
            </code>
          </div>
        </section>
      )}

      {state.step !== "credentials" && (
        <>
          <FormField
            name="code"
            label={labels.codeLabel}
            hint={labels.codeHint}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
          />
          <Button type="submit" disabled={pending}>
            {labels.codeSubmit}
          </Button>
          {/* Обычная ссылка на эту же страницу: шаг пароля начинается заново. */}
          <a
            href=""
            className="self-center text-sm font-medium text-link underline-offset-4 hover:underline"
          >
            {labels.startOver}
          </a>
        </>
      )}
    </form>
  );
}
