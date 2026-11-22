import { getTranslations } from 'next-intl/server';
import type { OncallView } from '@/modules/hdn/api/mail-settings';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Textarea } from '@/ui/components/textarea';
import { oncallTestAction, saveOncallAction } from './actions';

// Дежурные (решение 8): адреса для писем о P1, бот (основной или отдельный с токеном), номер чата, проверочное сообщение.
// Токен на экран не возвращается: после сохранения поле пустое и подписано "токен сохранён".

export async function OncallForm({ oncall, mainBot }: { oncall: OncallView; mainBot: string | null }) {
  const t = await getTranslations('agent.settings.mail.oncall');
  return (
    <section aria-labelledby="mail-oncall" className="flex flex-col gap-3">
      <h2 id="mail-oncall" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-secondary-foreground">{t('intro')}</p>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <form action={saveOncallAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="oncall-emails">{t('emails')}</Label>
              <Textarea id="oncall-emails" name="emails" rows={3} defaultValue={oncall.emails.join('\n')} aria-describedby="oncall-emails-hint" />
              <p id="oncall-emails-hint" className="text-sm text-secondary-foreground">
                {t('emailsHint')}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="oncall-chat">{t('chat')}</Label>
              <Input id="oncall-chat" name="chatId" defaultValue={oncall.chatId ?? ''} maxLength={40} aria-describedby="oncall-chat-hint" />
              <p id="oncall-chat-hint" className="text-sm text-secondary-foreground">
                {t('chatHint')}
              </p>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t('bot')}</legend>
              <label htmlFor="oncall-bot-main" className="flex items-center gap-2 text-sm">
                <input id="oncall-bot-main" type="radio" name="bot" value="main" defaultChecked={oncall.bot === 'main'} className="size-4 accent-primary" />
                {mainBot ? t('botMainName', { name: `@${mainBot}` }) : t('botMain')}
              </label>
              <label htmlFor="oncall-bot-own" className="flex items-center gap-2 text-sm">
                <input id="oncall-bot-own" type="radio" name="bot" value="own" defaultChecked={oncall.bot === 'own'} className="size-4 accent-primary" />
                {t('botOwn')}
              </label>
            </fieldset>
            <div className="flex flex-col gap-1">
              <Label htmlFor="oncall-token">{t('token')}</Label>
              <Input id="oncall-token" name="botToken" type="password" autoComplete="off" maxLength={250} aria-describedby="oncall-token-hint" />
              <p id="oncall-token-hint" className="text-sm text-secondary-foreground">
                {oncall.botTokenSaved ? t('tokenSaved') : t('tokenHint')}
              </p>
            </div>
            <Button type="submit" className="self-start">
              {t('save')}
            </Button>
          </form>
          <form action={oncallTestAction} className="border-t border-border pt-3">
            <Button type="submit" variant="secondary">
              {t('test')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
