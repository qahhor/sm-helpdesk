import { getTranslations } from 'next-intl/server';
import { AI_FLAG_REASONS } from '@/modules/hda/api/constants';
import { Button } from '@/ui/components/button';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { flagAiAnswerAction } from './actions';

// "Отметить ответ как неверный" у сообщения помощника (план M5b, задача 8; FR-AI-16, экран 8.12). Раскрывающаяся форма
// без скриптов: причина из закрытого списка и необязательный комментарий. Отметку видят только сотрудники.

export async function FlagAiAnswer({ number, messageId }: { number: number; messageId: string }) {
  const t = await getTranslations('agent.ticket.flag');
  const id = `flag-${messageId}`;
  return (
    <details className="text-sm" data-flag-ai>
      <summary className="cursor-pointer text-link">{t('open')}</summary>
      <form action={flagAiAnswerAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="number" value={number} />
        <input type="hidden" name="messageId" value={messageId} />
        <Label htmlFor={`${id}-reason`}>{t('reason')}</Label>
        <Select id={`${id}-reason`} name="reason" required defaultValue="wrong_solution">
          {AI_FLAG_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {t(`reasons.${reason}`)}
            </option>
          ))}
        </Select>
        <Label htmlFor={`${id}-comment`}>{t('comment')}</Label>
        <Textarea id={`${id}-comment`} name="comment" maxLength={500} rows={2} aria-describedby={`${id}-hint`} />
        <p id={`${id}-hint`} className="text-xs text-secondary-foreground">
          {t('commentHint')}
        </p>
        <Button type="submit" variant="secondary" size="small" className="self-start">
          {t('submit')}
        </Button>
      </form>
    </details>
  );
}
