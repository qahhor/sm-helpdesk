import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { listComments } from '@/modules/hdi/api/comments';
import { COMMENT_MAX } from '@/modules/hdi/api/constants';
import type { ClientActor } from '@/db/with-actor';
import { Button } from '@/ui/components/button';
import { Label } from '@/ui/components/label';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Textarea } from '@/ui/components/textarea';
import { addCommentAction, editCommentAction } from '../actions';

// Комментарии к идее у клиента (ТЗ FR-IDEA-07; план M7, задача 7, решения 8, 13): старые сверху, по 50, текст только
// текстовыми узлами без ссылок. Свои на проверке с пометкой "На проверке", скрытые модератором с причиной, ответ Smartup
// со значком. Форма без скриптов; свой комментарий правится первые 15 минут.

export async function IdeaComments({ actor, number, after, canComment }: { actor: ClientActor; number: number; after: string | undefined; canComment: boolean }) {
  const t = await getTranslations('client.ideas.comments');
  const format = await getFormatter();
  const page = await listComments(actor, { number, ...(after ? { after } : {}) });
  return (
    <section aria-labelledby="idea-comments" className="flex flex-col gap-3" data-testid="idea-comments">
      <h2 id="idea-comments" className="text-lg font-semibold">
        {t('title')}
      </h2>
      {page.items.length === 0 && !after && <p className="text-sm text-secondary-foreground">{t('empty')}</p>}
      <ul className="flex flex-col gap-2">
        {page.items.map((c) => (
          <li key={c.commentId} data-comment={c.commentId} className={`flex flex-col gap-1 rounded-card border p-3 ${c.isOfficial ? 'border-primary bg-selected' : 'border-border bg-card'}`}>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{c.authorName}</span>
              {c.isOfficial && <StatusLabel tone="blue">{t('official')}</StatusLabel>}
              {c.status === 'pending' && <StatusLabel tone="orange">{t('pending')}</StatusLabel>}
              {c.status === 'hidden' && <StatusLabel tone="danger">{t('hidden')}</StatusLabel>}
              <span className="text-secondary-foreground">{format.dateTime(c.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</span>
            </p>
            <p className="whitespace-pre-wrap break-words">{c.body}</p>
            {c.status === 'hidden' && c.hideReason && <p className="whitespace-pre-wrap break-words text-sm text-secondary-foreground">{t('hideReason', { reason: c.hideReason })}</p>}
            {c.editable && (
              <details>
                <summary className="cursor-pointer text-sm text-link">{t('edit')}</summary>
                <form action={editCommentAction} className="mt-2 flex flex-col gap-2">
                  <input type="hidden" name="number" value={number} />
                  <input type="hidden" name="commentId" value={c.commentId} />
                  <Label htmlFor={`edit-${c.commentId}`}>{t('label')}</Label>
                  <Textarea id={`edit-${c.commentId}`} name="body" required rows={3} maxLength={COMMENT_MAX} defaultValue={c.body} />
                  <Button type="submit" size="small" variant="secondary" className="self-start">
                    {t('save')}
                  </Button>
                </form>
              </details>
            )}
          </li>
        ))}
      </ul>
      {page.next && (
        <Link href={`/ideas/${number}?after=${page.next}#idea-comments`} className="self-center text-link underline-offset-2 hover:underline">
          {t('more')}
        </Link>
      )}
      {canComment && (
        <form action={addCommentAction} className="flex flex-col gap-2">
          <input type="hidden" name="number" value={number} />
          <Label htmlFor="new-comment">{t('label')}</Label>
          <Textarea id="new-comment" name="body" required rows={3} maxLength={COMMENT_MAX} />
          <p className="text-sm text-secondary-foreground">{t('hint')}</p>
          <Button type="submit" className="self-start">
            {t('send')}
          </Button>
        </form>
      )}
    </section>
  );
}
