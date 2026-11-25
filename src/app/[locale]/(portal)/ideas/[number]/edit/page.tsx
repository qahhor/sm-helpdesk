import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/locales';
import { ideaPage } from '@/modules/hdi/api/board';
import { IDEA_BODY_MAX, IDEA_TITLE_MAX, ideaRef, parseIdeaNumber } from '@/modules/hdi/api/constants';
import { listActiveModules } from '@/modules/hdr/api';
import { requireClientActor } from '@/modules/hdu/api';
import { firstParam } from '@/lib/search-params';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { editIdeaAction } from '../../actions';

// Правка своей идеи, пока она на модерации (план M7, задача 5, решение 5): заголовок, описание, модуль и показ
// организации. Чужая или уже опубликованная идея: "Не найдено". Форма без скриптов.

export default async function EditIdeaPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ status?: string }> }) {
  const client = await requireClientActor();
  const locale = (await getLocale()) as Locale;
  const number = parseIdeaNumber((await params).number);
  if (!number) notFound();
  const idea = await ideaPage(client, { number, locale });
  if (!idea?.canEdit) notFound();
  const t = await getTranslations('client.ideas');
  const status = firstParam((await searchParams).status) ?? '';
  const code = status.startsWith('error-') ? status.slice(6) : null;
  const modules = await listActiveModules(client.actor, locale);
  return (
    <>
      <Link href={`/ideas/${idea.number}`} className="self-start text-sm text-link underline-offset-2 hover:underline">
        {ideaRef(idea.number)}
      </Link>
      <h1 className="text-2xl font-bold">{t('page.editTitle')}</h1>
      {code && <Alert tone="danger">{t(`errors.${['invalid_input', 'rate_limited', 'not_editable'].includes(code) ? code : 'forbidden'}`)}</Alert>}
      <Card className="p-4">
        <form action={editIdeaAction} className="flex flex-col gap-4">
          <input type="hidden" name="number" value={idea.number} />
          <div className="flex flex-col gap-1">
            <Label htmlFor="idea-title">{t('new.titleLabel')}</Label>
            <Input id="idea-title" name="title" required maxLength={IDEA_TITLE_MAX} defaultValue={idea.original.title} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="idea-body">{t('new.body')}</Label>
            <Textarea id="idea-body" name="body" required rows={8} maxLength={IDEA_BODY_MAX} defaultValue={idea.original.body} />
            <p className="text-sm text-secondary-foreground">{t('new.bodyHint')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="idea-module">{t('new.module')}</Label>
            <Select id="idea-module" name="moduleId" defaultValue={idea.moduleId ?? ''}>
              <option value="">{t('new.moduleNone')}</option>
              {modules.map((m) => (
                <option key={m.moduleId} value={m.moduleId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="showOrg" defaultChecked={idea.showOrg} className="size-4 accent-primary" />
            <span>{t('new.showOrg')}</span>
          </label>
          <div className="flex flex-col gap-3 tablet:flex-row">
            <Button type="submit">{t('page.save')}</Button>
            <Button asChild variant="secondary">
              <Link href={`/ideas/${idea.number}`}>{t('page.cancel')}</Link>
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
