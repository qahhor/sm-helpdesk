import { getTranslations } from 'next-intl/server';
import { listTags, TAG_COLORS, TAG_NAME_MAX } from '@/modules/hdr/api';
import { tagUsage } from '@/modules/hdt/api';
import { requireStaffActor } from '@/modules/hdu/api';
import { TagChip } from '@/ui/agent/TagChip';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from '../sections';
import { deleteTagAction, updateTagAction } from './actions';

// "Теги" (FR-AUTO-13; план M8, задача 1, решение 8): тег создаёт сотрудник прямо на обращении, здесь администратор
// переименовывает, перекрашивает и удаляет. Удаление снимает тег со всех обращений.

const DONE = new Set(['saved', 'deleted']);
const ERRORS = new Set(['forbidden', 'invalid_input', 'tag_taken', 'not_found', 'stale_session']);

export default async function TagsSettingsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const { done, error } = await searchParams;
  const [tags, usage] = await Promise.all([listTags(staff), tagUsage(staff)]);
  const nav = await settingsNav('tags');
  return (
    <>
      <PageHeader
        title={t('settings.tags.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: t('settings.tags.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <SettingsLayout {...nav}>
        {done && DONE.has(done) && <Alert tone="success">{t(`settings.tags.done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && <Alert tone="danger">{t(`settings.tags.errors.${error}`)}</Alert>}
        <p className="text-secondary-foreground">{t('settings.tags.intro')}</p>
        {tags.length === 0 && (
          <Card>
            <EmptyState title={t('settings.tags.emptyTitle')} text={t('settings.tags.emptyText')} />
          </Card>
        )}
        {tags.map((tag) => {
          const count = usage.get(tag.tagId) ?? 0;
          return (
            <Card key={tag.tagId} data-tag-row={tag.name}>
              <CardContent className="flex flex-col gap-3 pt-6">
                <div className="flex flex-wrap items-center gap-2">
                  <TagChip color={tag.color}>{tag.name}</TagChip>
                  <span className="text-sm text-muted-foreground">{t('settings.tags.usage', { count })}</span>
                </div>
                <form action={updateTagAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="tagId" value={tag.tagId} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Label htmlFor={`tag-${tag.tagId}-name`}>{t('settings.tags.name')}</Label>
                    <Input id={`tag-${tag.tagId}-name`} name="name" required maxLength={TAG_NAME_MAX} defaultValue={tag.name} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`tag-${tag.tagId}-color`}>{t('settings.tags.color')}</Label>
                    <Select id={`tag-${tag.tagId}-color`} name="color" defaultValue={tag.color}>
                      {TAG_COLORS.map((color) => (
                        <option key={color} value={color}>
                          {t(`settings.tags.colors.${color}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button type="submit" variant="secondary">
                    {t('settings.tags.save')}
                  </Button>
                </form>
                <details>
                  <summary className="cursor-pointer text-sm text-link">{t('settings.tags.delete')}</summary>
                  <form action={deleteTagAction} className="mt-2 flex flex-wrap items-center gap-3">
                    <input type="hidden" name="tagId" value={tag.tagId} />
                    <p className="text-sm text-secondary-foreground">{t('settings.tags.deleteText', { count })}</p>
                    <Button type="submit" variant="danger" size="small">
                      {t('settings.tags.deleteConfirm')}
                    </Button>
                  </form>
                </details>
              </CardContent>
            </Card>
          );
        })}
      </SettingsLayout>
    </>
  );
}
