import { Laptop } from "lucide-react";
import { Button } from "./button";

export type SessionItem = {
  sessionId: string;
  device: string;
  ip: string | null;
  createdOn: string;
  lastSeenOn: string;
  isCurrent: boolean;
};

export type SessionsListLabels = {
  current: string;
  ip: string;
  unknownIp: string;
  signedIn: string;
  lastSeen: string;
  revoke: string;
  revokeOthers: string;
  /** Сколько сессий не показано: подпись уже с числом. Пусто, если показаны все. */
  hiddenNote: string | null;
};

/**
 * Список сессий пользователя: кабинет клиента (/settings) и рабочее место (/agent/account).
 * Подписи и даты готовит страница, завершение это серверное действие страницы.
 * Показываются последние сессии, остальные завершаются кнопкой "Завершить все другие сессии".
 */
export function SessionsList({
  items,
  labels,
  revoke,
  revokeOthers,
}: {
  items: SessionItem[];
  labels: SessionsListLabels;
  revoke: (formData: FormData) => Promise<void>;
  revokeOthers: () => Promise<void>;
}) {
  const hasOthers =
    items.some((item) => !item.isCurrent) || labels.hiddenNote !== null;
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col">
        {items.map((item) => (
          <li
            key={item.sessionId}
            className="flex flex-col gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0 tablet:flex-row tablet:items-center"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Laptop
                className="mt-0.5 size-5 shrink-0 text-secondary-foreground"
                aria-hidden
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="font-medium">
                  {item.device}
                  {item.isCurrent && (
                    <span className="ms-2 rounded-control bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">
                      {labels.current}
                    </span>
                  )}
                </p>
                <p className="text-sm text-secondary-foreground">
                  {labels.ip}: {item.ip ?? labels.unknownIp}
                </p>
                <p className="text-sm text-secondary-foreground">
                  {labels.signedIn}: {item.createdOn}. {labels.lastSeen}:{" "}
                  {item.lastSeenOn}
                </p>
              </div>
            </div>
            <form action={revoke}>
              <input type="hidden" name="sessionId" value={item.sessionId} />
              <Button type="submit" variant="secondary">
                {labels.revoke}
              </Button>
            </form>
          </li>
        ))}
      </ul>
      {labels.hiddenNote && (
        <p className="text-sm text-secondary-foreground">{labels.hiddenNote}</p>
      )}
      {hasOthers && (
        <form action={revokeOthers}>
          <Button type="submit" variant="danger" className="h-auto min-h-control max-w-full whitespace-normal py-2 text-center">
            {labels.revokeOthers}
          </Button>
        </form>
      )}
    </div>
  );
}
