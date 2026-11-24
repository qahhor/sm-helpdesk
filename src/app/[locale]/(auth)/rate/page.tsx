import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { firstParam } from '@/lib/search-params';
import { csatLinkNumber } from '@/modules/hdt/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { rateByLinkAction } from './actions';

// Оценка обращения по ссылке из письма (FR-TK-11, UX-C-07; решение 0040). Открытие страницы ничего не меняет:
// почтовый сканер, который открыл ссылку первым, оценку не ставит. Ставит её только нажатие кнопки.
// Вход не нужен: правом служит подпись ссылки. Страница показывает только номер обращения, без его текста.

const ERRORS = ['link_invalid', 'already_rated', 'not_closed', 'reason_required', 'rate_limited'] as const;
const REASONS = ['slow', 'not_solved', 'unclear', 'other'] as const;

export default async function RatePage({ searchParams }: PageProps<'/[locale]/rate'>) {
  const params = await searchParams;
  const t = await getTranslations('auth.rate');
  const token = firstParam(params.t);
  const score = Number(firstParam(params.score));
  const number = csatLinkNumber(token);
  const error = ERRORS.find((code) => code === firstParam(params.error));
  const valid = number !== null && Number.isInteger(score) && score >= 1 && score <= 5;
  const home = (
    <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
      {t('open')}
    </Link>
  );

  if (firstParam(params.done) === '1')
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Alert tone="success">{t('done')}</Alert>
          {home}
        </CardContent>
      </Card>
    );

  if (!valid)
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Alert tone="danger">{t(`errors.${error ?? 'link_invalid'}`)}</Alert>
          {home}
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('title', { number })}</h1>
        <p className="text-secondary-foreground">{t('text', { score })}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert tone="danger">{t(`errors.${error}`)}</Alert>}
        <form action={rateByLinkAction} className="flex flex-col gap-4">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="score" value={score} />
          {score <= 3 && (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rate-reason">{t('reason')}</Label>
                <Select id="rate-reason" name="reason" required defaultValue="">
                  <option value="" disabled />
                  {REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {t(`reasons.${reason}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rate-comment">{t('comment')}</Label>
                <Textarea id="rate-comment" name="comment" maxLength={2000} />
              </div>
            </>
          )}
          <Button type="submit" className="w-full">
            {t('submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
