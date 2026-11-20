import { type NextRequest, NextResponse } from 'next/server';
import { getEnv } from '@/env';
import { isLocale } from '@/i18n/locales';
import { startTelegramLinkOfRequest } from '@/modules/hdu/api';

// Кнопка "Привязать Telegram": код привязки и переход в бота (t.me/<бот>?start=<код>).
// Обычная ссылка, а не отправка формы: после формы браузер ушёл бы на чужой адрес,
// а политика CSP разрешает формам только адрес портала (form-action 'self', как у входа через Smartup).
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: RouteContext<'/[locale]/settings/telegram'>): Promise<Response> {
  const { locale } = await params;
  if (!isLocale(locale)) return new NextResponse(null, { status: 404 });
  const result = await startTelegramLinkOfRequest({ headers: request.headers });
  const back = (query: string) => new URL(`/${locale}${query}`, getEnv().HUB_URL).toString();
  const target = 'url' in result ? result.url : result.error === 'no_session' ? back('/login?next=%2F' + locale + '%2Fsettings') : back(`/settings?telegram=${result.error}`);
  const response = NextResponse.redirect(target, 303);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
