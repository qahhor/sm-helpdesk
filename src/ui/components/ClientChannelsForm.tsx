import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { TAP_BOX } from '@/ui/tap';

// Каналы уведомлений клиента (FR-NT-04, FR-NT-14; решения 3 и 4 вехи M4b): строки "О своих обращениях" и
// "Об обращениях коллег", столбцы "Почта" и "Telegram". Портал всегда. Имя галочки складывается из строки и
// столбца (aria-labelledby). Правило "хотя бы один внешний канал о своих обращениях" проверяет сервер.

export type ChannelRow = { key: 'own' | 'watched'; label: string; email: boolean; telegram: boolean };

export type ClientChannelsLabels = {
  title: string;
  intro: string;
  kind: string;
  email: string;
  telegram: string;
  ownRule: string;
  telegramMissing: string;
  /** Привязка есть, но человек заблокировал бота: причина другая, и подсказка другая (M4b, мелкое 3). */
  telegramBlocked: string;
  telegramLink: string;
  needTelegram: string;
  ownFallback: string;
  save: string;
  saved: string;
};

export function ClientChannelsForm({
  rows,
  labels,
  telegram,
  status,
  ownFallback,
  save,
}: {
  rows: ChannelRow[];
  labels: ClientChannelsLabels;
  /** null: бот портала выключен, столбца Telegram нет. */
  /** linkHref: ссылка на раздел привязки Telegram на этой же странице. */
  telegram: { active: boolean; blocked: boolean; linkHref: string } | null;
  status: 'saved' | 'need_telegram' | null;
  /** Почта о своих обращениях выключена, но Telegram не действует: письма всё равно идут. */
  ownFallback: boolean;
  save: (formData: FormData) => Promise<void>;
}) {
  const cell = 'px-2 py-2 text-center';
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">{labels.title}</h2>
        <p className="text-secondary-foreground">{labels.intro}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status === 'saved' && <Alert tone="success">{labels.saved}</Alert>}
        {status === 'need_telegram' && <Alert tone="danger">{labels.needTelegram}</Alert>}
        {ownFallback && <Alert tone="info">{labels.ownFallback}</Alert>}
        <form action={save} className="flex flex-col gap-3">
          <table className="w-full">
            <thead>
              <tr>
                <th scope="col" className="py-2 text-start font-medium">
                  {labels.kind}
                </th>
                <th scope="col" id="channel-email" className={`${cell} font-medium`}>
                  {labels.email}
                </th>
                {telegram && (
                  <th scope="col" id="channel-telegram" className={`${cell} font-medium`}>
                    {labels.telegram}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <th scope="row" id={`channel-row-${row.key}`} className="py-2 text-start font-normal">
                    {row.label}
                  </th>
                  <td className={cell}>
                    {/* Бот портала выключен: о своих обращениях остаётся только почта, выключить её нельзя. */}
                    {!telegram && row.key === 'own' ? (
                      <>
                        <label className={TAP_BOX}>
                          <input type="checkbox" checked disabled aria-labelledby={`channel-row-${row.key} channel-email`} className="size-5 accent-primary" />
                        </label>
                        <input type="hidden" name={`${row.key}Email`} value="on" />
                      </>
                    ) : (
                      // Флажок без видимой подписи: область нажатия 44 px задаёт обёртка (проверка интерфейса, U11).
                      <label className={TAP_BOX}>
                        <input
                          type="checkbox"
                          name={`${row.key}Email`}
                          defaultChecked={row.email}
                          aria-labelledby={`channel-row-${row.key} channel-email`}
                          className="size-5 accent-primary"
                        />
                      </label>
                    )}
                  </td>
                  {telegram && (
                    <td className={cell}>
                      <label className={TAP_BOX}>
                        <input
                          type="checkbox"
                          name={`${row.key}Telegram`}
                          defaultChecked={row.telegram}
                          aria-labelledby={`channel-row-${row.key} channel-telegram`}
                          className="size-5 accent-primary"
                        />
                      </label>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {/* Без Telegram столбца нет: значение сохраняется включённым, канал начнёт действовать после привязки. */}
          {!telegram && rows.map((row) => <input key={row.key} type="hidden" name={`${row.key}Telegram`} value={row.telegram ? 'on' : ''} />)}
          {telegram && <p className="text-sm text-secondary-foreground">{labels.ownRule}</p>}
          {telegram && !telegram.active && (
            <p className="text-sm text-secondary-foreground">
              {telegram.blocked ? labels.telegramBlocked : labels.telegramMissing}{' '}
              <a href={telegram.linkHref} className="text-primary underline">
                {labels.telegramLink}
              </a>
            </p>
          )}
          <Button type="submit" variant="secondary" className="self-start">
            {labels.save}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
