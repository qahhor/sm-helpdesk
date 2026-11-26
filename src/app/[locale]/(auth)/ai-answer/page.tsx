import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { aiLinkInfo } from '@/modules/hdt/api/ai-link';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { aiAnswerAction } from './actions';

// Ответ на сообщение Теза по ссылке из письма (план M5b, задача 6; FR-NT-11, FR-EM-12; пункт 7 проверки на
// AI-инъекции). Открытие страницы ничего не меняет: почтовый сканер, открывший ссылку первым, не нажимает
// "Помогло" за клиента. Действие выполняет кнопка. Вход не нужен: правом служит подпись ссылки. Страница показывает
// только номер обращения, без его текста.

const ERRORS = ['link_invalid', 'expired', 'already_done', 'rate_limited'] as const;
const DONE = ['helped', 'need_staff'] as const;

export default async function AiAnswerPage({ searchParams }: PageProps<'/[locale]/ai-answer'>) {
  const params = await searchParams;
  const t = await getTranslations('auth.aiAnswer');
  const home = (
    <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
      {t('open')}
    </Link>
  );
  const done = DONE.find((code) => code === firstParam(params.done));
  if (done)
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Alert tone="success">{t(`done.${done}`)}</Alert>
          {home}
        </CardContent>
      </Card>
    );
  const token = firstParam(params.t);
  const error = ERRORS.find((code) => code === firstParam(params.error));
  const info = token ? await aiLinkInfo(token) : null;
  if (!info || !info.ok)
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Alert tone="danger">{t(`errors.${error ?? (info && !info.ok ? info.code : 'link_invalid')}`)}</Alert>
          {home}
        </CardContent>
      </Card>
    );
  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title', { number: info.number })}</h1>
        <p className="text-secondary-foreground">{info.choice === 'helped' ? t('helped') : t('needStaff')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert tone="danger">{t(`errors.${error}`)}</Alert>}
        <form action={aiAnswerAction}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit">{info.choice === 'helped' ? t('confirmHelped') : t('confirmStaff')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
