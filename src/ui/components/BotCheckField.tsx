import type { Locale } from '@/i18n/locales';

const WIDGET_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

/** Поле формы, в которое виджет кладёт токен. Его читают серверные действия форм входа. */
export const BOT_TOKEN_FIELD = 'cf-turnstile-response';

/** Что нужно форме для виджета: ключ сайта (без него проверки нет), одноразовый код страницы и язык. */
export type BotCheckProps = { siteKey: string | undefined; nonce: string; locale: Locale };

/**
 * Виджет проверки "не робот" внутри формы входа (Cloudflare Turnstile, решение 0018).
 * Без ключа сайта не выводит ничего: проверка выключена. Виджет сам кладёт токен в поле формы
 * cf-turnstile-response. Скрипт подключается с одноразовым кодом страницы, политика CSP разрешает его адрес.
 * Неподдерживаемый язык виджет заменяет английским.
 */
export function BotCheckField({ siteKey, nonce, locale }: BotCheckProps) {
  if (!siteKey) return null;
  return (
    <>
      <script src={WIDGET_SCRIPT} async defer nonce={nonce} />
      <div className="cf-turnstile" data-sitekey={siteKey} data-language={locale} data-size="flexible" />
    </>
  );
}
