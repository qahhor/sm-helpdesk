import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale, TIME_ZONE } from './locales';
import { loadMessages } from './messages';

// Настройка next-intl для каждого запроса: язык из адреса, сообщения с запасными языками,
// единый часовой пояс.
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = requested && isLocale(requested) ? requested : DEFAULT_LOCALE;
  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: TIME_ZONE,
  };
});
