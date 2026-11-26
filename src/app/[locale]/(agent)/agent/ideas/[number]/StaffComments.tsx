import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { listComments } from '@/modules/hdi/api/comments';
import { COMMENT_MAX, DECLINE_REASON_MAX } from '@/modules/hdi/api/constants';
import type { StaffActor } from '@/db/with-actor';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { Textarea } from '@/ui/components/textarea';
import { moderateCommentAction, staffReplyAction } from '../actions';

// Комментарии идеи на рабочем месте (ТЗ FR-IDEA-07; план M7, задача 7, решение 8): все, включая скрытые и на проверке.
// Тексты клиентов только текстовыми узлами. Ответить со значком Smartup может любой сотрудник, опубликовать удержанный и
// скрыть с причиной только product и admin. Организация автора комментария не показывается.

export async function StaffComments({ actor, number, after, canModerate, canReply }: { actor: StaffActor; number: number; after: string | undefined; canModerate: boolean; canReply: boolean }) {
  const t = await getTranslations('agent.ideas.comments');
  const ct = await getTranslations('client.ideas.comments');
  const format = await getFormatter();
  const page = await listComments(actor, { number, ...(after ? { after } : {}) });
  return (
    <Card>
      <CardHeader>
        <h2 id="idea-comments" className="text-lg font-semibold">
          {ct('title')}
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3" data-testid="staff-comments">
        {page.items.length === 0 && !after && <p className="text-sm text-secondary-foreground">{ct('empty')}</p>}
        <ul className="flex flex-col gap-2">
          {page.items.map((c) => (
            <li key={c.commentId} data-comment={c.commentId} className="flex flex-col gap-1 rounded-card border border-border p-3">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">{c.authorName}</span>
                {c.isOfficial && <StatusLabel tone="blue">{ct('official')}</StatusLabel>}
                {c.status === 'pending' && <StatusLabel tone="orange">{ct('pending')}</StatusLabel>}
                {c.status === 'hidden' && <StatusLabel tone="danger">{ct('hidden')}</StatusLabel>}
                <span className="text-secondary-foreground">{format.dateTime(c.createdOn, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </p>
              <p className="whitespace-pre-wrap break-words">{c.body}</p>
              {canModerate && c.status !== 'hidden' && (
                <div className="flex flex-col gap-2 tablet:flex-row tablet:items-end">
                  {c.status === 'pending' && (
                    <form action={moderateCommentAction}>
                      <input type="hidden" name="number" value={number} />
                      <input type="hidden" name="commentId" value={c.commentId} />
                      <input type="hidden" name="action" value="publish" />
                      <Button type="submit" size="small">
                        {t('publish')}
                      </Button>
                    </form>
                  )}
                  <form action={moderateCommentAction} className="flex flex-col gap-1 tablet:flex-row tablet:items-end tablet:gap-2">
                    <input type="hidden" name="number" value={number} />
                    <input type="hidden" name="commentId" value={c.commentId} />
                    <input type="hidden" name="action" value="hide" />
                    <span className="flex flex-col gap-1">
                      <Label htmlFor={`hide-${c.commentId}`}>{t('hideReason')}</Label>
                      <Input id={`hide-${c.commentId}`} name="reason" required maxLength={DECLINE_REASON_MAX} />
                    </span>
                    <Button type="submit" size="small" variant="secondary">
                      {t('hide')}
                    </Button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
        {page.next && (
          <Link href={`/agent/ideas/${number}?after=${page.next}#idea-comments`} className="self-center text-link underline-offset-2 hover:underline">
            {ct('more')}
          </Link>
        )}
        {canReply && (
          <form action={staffReplyAction} className="flex flex-col gap-2">
            <input type="hidden" name="number" value={number} />
            <Label htmlFor="staff-reply">{t('reply')}</Label>
            <Textarea id="staff-reply" name="body" required rows={3} maxLength={COMMENT_MAX} />
            <Button type="submit" className="self-start">
              {t('send')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
