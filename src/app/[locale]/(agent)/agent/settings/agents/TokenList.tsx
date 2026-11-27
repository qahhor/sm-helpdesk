import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { AgentTokenView } from '@/modules/hda/api/agent-admin';
import { Card } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { StatusLabel } from '@/ui/components/StatusLabel';

// Список токенов AI-сотрудников (экран 8.12): имя, инструменты чтения и записи, срок, последний вызов, вызовы за
// сутки из предела, состояние. Значения токена здесь нет: только последние 4 знака.

export const STATE_TONES = { active: 'green', expired: 'gray', revoked: 'danger' } as const;

export async function TokenList({ tokens }: { tokens: AgentTokenView[] }) {
  const t = await getTranslations('agent.settings.agents');
  const format = await getFormatter();
  if (tokens.length === 0)
    return (
      <Card>
        <EmptyState title={t('emptyTitle')} text={t('emptyText')} />
      </Card>
    );
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm" aria-label={t('listLabel')}>
        <thead>
          <tr className="border-b border-border text-start text-muted-foreground">
            {(['name', 'tools', 'expiresAt', 'lastUsedAt', 'calls', 'state'] as const).map((column) => (
              <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                {t(`columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr key={token.tokenId} data-agent-token-row={token.name} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="px-3 py-3 text-start font-normal">
                <Link href={`/agent/settings/agents/${token.tokenId}`} className="break-words font-semibold text-link underline-offset-2 hover:underline">
                  {token.name}
                </Link>
                <span className="block text-muted-foreground">{t('last4', { last4: token.last4 })}</span>
                {token.isEventParent && <span className="block text-muted-foreground">{t('eventParent.mark')}</span>}
              </th>
              <td className="px-3 py-3">{t('toolCounts', { read: token.readTools, write: token.writeTools })}</td>
              <td className="whitespace-nowrap px-3 py-3">{format.dateTime(token.expiresAt, { dateStyle: 'medium' })}</td>
              <td className="whitespace-nowrap px-3 py-3">{token.lastUsedAt ? format.dateTime(token.lastUsedAt, { dateStyle: 'medium', timeStyle: 'short' }) : t('never')}</td>
              <td className="whitespace-nowrap px-3 py-3 tabular-nums">{t('callsOf', { calls: token.callsToday, limit: token.dailyLimit })}</td>
              <td className="px-3 py-3">
                <StatusLabel tone={STATE_TONES[token.state]}>{t(`states.${token.state}`)}</StatusLabel>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
