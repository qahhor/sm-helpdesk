import { type NextRequest, NextResponse } from 'next/server';
import { isLocale } from '@/i18n/locales';
import { startSmartupSignIn } from '@/modules/hdu/api';

// Начало входа через Smartup: переход по ссылке "Войти через Smartup" (FR-ID-01).
// Обычная ссылка, а не отправка формы: после формы браузер ушёл бы на адрес сервера Smartup,
// а политика CSP разрешает формам только адрес портала (form-action 'self', ТЗ 14.4).
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: RouteContext<'/[locale]/login/smartup'>): Promise<Response> {
  const { locale } = await params;
  if (!isLocale(locale)) return new NextResponse(null, { status: 404 });
  const cookies = new Headers();
  const result = await startSmartupSignIn(
    { locale, next: request.nextUrl.searchParams.get('next') },
    { headers: request.headers, setCookies: (headers) => headers.getSetCookie().forEach((line) => cookies.append('set-cookie', line)) },
  );
  const target = 'url' in result ? result.url : new URL(`/${locale}/login?error=${result.error}`, request.nextUrl).toString();
  const response = NextResponse.redirect(target, 303);
  for (const line of cookies.getSetCookie()) response.headers.append('set-cookie', line);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
