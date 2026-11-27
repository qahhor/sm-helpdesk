import { getLocale, getTranslations } from 'next-intl/server';
import { firstParam } from '@/lib/search-params';
import { AGENT_DAILY_LIMIT_DEFAULT, listAgentTokens, readTeamChat } from '@/modules/hda/api/agent-admin';
import { requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button, buttonVariants } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { FormField } from '@/ui/components/form-field';
import { PageHeader } from '@/ui/components/PageHeader';
import { SettingsLayout } from '@/ui/components/SettingsLayout';
import { settingsNav } from '../sections';
import { saveTeamChatAction } from './actions';
import { tokenFormProps } from './form-labels';
import { TokenForm } from './TokenForm';
import { TokenList } from './TokenList';

// "AI-сотрудники" (FR-AGT-02, FR-AGT-09, FR-ADM-13, экран 8.12; план M8b, задача 3, решения 10, 24, 28): токены
// внутренних агентов для сервера MCP, выпуск с показом значения один раз и служебный чат команды для сообщений по
// сводкам. Только администратор портала; изменения требуют свежего входа.

const DONE = new Set(['revoked', 'chatSaved']);
const ERRORS = new Set(['forbidden', 'stale_session', 'invalid_input', 'not_found']);

export default async function AgentsSettingsPage({ searchParams }: PageProps<'/[locale]/agent/settings/agents'>) {
  const staff = await requireStaffActor({ roles: ['admin'] });
  const t = await getTranslations('agent');
  const a = await getTranslations('agent.settings.agents');
  const locale = await getLocale();
  const query = await searchParams;
  const done = firstParam(query.done);
  const error = firstParam(query.error);
  const [tokens, chatId, form] = await Promise.all([listAgentTokens(staff), readTeamChat(staff), tokenFormProps('new')]);
  const here = '/agent/settings/agents';
  const reauthHref = `/${locale}/staff/login?reauth=1&next=${encodeURIComponent(`/${locale}${here}`)}`;
  return (
    <>
      <PageHeader
        title={a('title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('settings.title'), href: '/agent/settings' }, { label: a('title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
        action={
          <a href="#issue" className={buttonVariants()}>
            {a('issueToken')}
          </a>
        }
      />
      <SettingsLayout {...await settingsNav('agents')}>
        {done && DONE.has(done) && <Alert tone="success">{a(`done.${done}`)}</Alert>}
        {error && ERRORS.has(error) && (
          <Alert tone="danger">
            {a(`errors.${error}`)}
            {error === 'stale_session' && (
              <>
                {' '}
                <a href={reauthHref} className="font-semibold underline">
                  {a('reauth')}
                </a>
              </>
            )}
          </Alert>
        )}
        <p className="text-secondary-foreground">{a('intro')}</p>
        <TokenList tokens={tokens} />

        <Card id="issue" className="scroll-mt-4">
          <CardHeader>
            <h2 className="text-base font-semibold">{a('form.newTitle')}</h2>
          </CardHeader>
          <CardContent>
            <TokenForm
              defaults={{ name: '', tools: [], allowedIps: '', expiresAt: form.defaultExpiresAt, dailyLimit: String(AGENT_DAILY_LIMIT_DEFAULT) }}
              readTools={form.readTools}
              writeTools={form.writeTools}
              labels={form.labels}
              reauthHref={reauthHref}
              tokenHref={`/${locale}${here}`}
            />
          </CardContent>
        </Card>

        <Card id="team-chat" className="scroll-mt-4">
          <CardHeader>
            <h2 className="text-base font-semibold">{a('teamChat.title')}</h2>
          </CardHeader>
          <CardContent>
            <form action={saveTeamChatAction} className="flex flex-col gap-4">
              <p className="text-sm text-secondary-foreground">{a('teamChat.text')}</p>
              <FormField name="chatId" label={a('teamChat.label')} hint={a('teamChat.hint')} defaultValue={chatId ?? ''} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={20} />
              <Button type="submit" variant="secondary" className="self-start">
                {a('teamChat.save')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </SettingsLayout>
    </>
  );
}
