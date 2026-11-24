import { X } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { type Tag, TAG_NAME_MAX } from '@/modules/hdr/api';
import { TagChip } from '@/ui/agent/TagChip';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { addTagAction, removeTagAction } from './actions';

// Теги обращения у сотрудника (FR-AUTO-13; план M8, задача 1): метки, снятие и постановка. Обычные формы без
// скриптов: поле с подсказками из справочника (datalist), новое название создаёт тег. Клиент блока не видит.

type Props = {
  number: number;
  tags: Tag[];
  /** Весь справочник: подсказки при вводе. */
  known: Tag[];
  canWrite: boolean;
};

export async function TicketTags({ number, tags, known, canWrite }: Props) {
  const t = await getTranslations('agent.ticket.tags');
  const onTicket = new Set(tags.map((tag) => tag.tagId));
  const suggestions = known.filter((tag) => !onTicket.has(tag.tagId));
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-6 text-sm" data-ticket-tags>
        <h2 className="text-xs font-medium text-secondary-foreground">{t('title')}</h2>
        {tags.length === 0 ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label={t('title')}>
            {tags.map((tag) => (
              <li key={tag.tagId} className="flex max-w-full items-center gap-1">
                <TagChip color={tag.color}>{tag.name}</TagChip>
                {canWrite && (
                  <form action={removeTagAction}>
                    <input type="hidden" name="number" value={number} />
                    <input type="hidden" name="tagId" value={tag.tagId} />
                    <button
                      type="submit"
                      aria-label={t('remove', { name: tag.name })}
                      title={t('remove', { name: tag.name })}
                      className="inline-flex size-6 items-center justify-center rounded-chip text-secondary-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X aria-hidden className="size-4" />
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <form action={addTagAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="number" value={number} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor="ticket-tag-name">{t('add')}</Label>
              <Input id="ticket-tag-name" name="name" required maxLength={TAG_NAME_MAX} list="ticket-tag-known" autoComplete="off" aria-describedby="ticket-tag-hint" />
              <datalist id="ticket-tag-known">
                {suggestions.map((tag) => (
                  <option key={tag.tagId} value={tag.name} />
                ))}
              </datalist>
              <p id="ticket-tag-hint" className="text-xs text-muted-foreground">
                {t('hint')}
              </p>
            </div>
            <Button type="submit" variant="secondary" className="mb-5">
              {t('submit')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
