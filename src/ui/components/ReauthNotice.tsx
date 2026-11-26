import { Alert } from "./alert";
import { Button } from "./button";

/**
 * Действие клиента просит недавний вход (ASVS 7.5, решение 0067): пояснение и кнопка "Войти заново".
 * Кнопка вызывает серверное действие выхода, затем страница входа возвращает на next.
 */
export function ReauthNotice({
  text,
  label,
  next,
  action,
}: {
  text: string;
  label: string;
  next: string;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <Alert tone="danger">
      <form action={action} className="flex flex-col items-start gap-2">
        <span>{text}</span>
        <input type="hidden" name="next" value={next} />
        <Button type="submit" variant="secondary" size="small">
          {label}
        </Button>
      </form>
    </Alert>
  );
}
