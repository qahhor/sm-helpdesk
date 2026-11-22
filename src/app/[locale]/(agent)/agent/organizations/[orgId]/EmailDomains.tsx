import { getTranslations } from 'next-intl/server';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { addDomainAction, removeDomainAction } from './actions';

// Домены почты организации (FR-EM-06, решение 15 вехи M4). Видят все сотрудники-люди, меняют Customer Care и администратор.

export async function EmailDomains({ orgId, domains, canManage }: { orgId: string; domains: string[]; canManage: boolean }) {
  const t = await getTranslations('agent.orgs.domains');
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">{t('title')}</h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-secondary-foreground">{t('intro')}</p>
        {domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label={t('title')}>
            {domains.map((domain) => (
              <li key={domain} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-semibold">{domain}</span>
                {canManage && (
                  <form action={removeDomainAction}>
                    <input type="hidden" name="orgId" value={orgId} />
                    <input type="hidden" name="domain" value={domain} />
                    <Button type="submit" variant="ghost" size="small">
                      {t('remove')}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form action={addDomainAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="orgId" value={orgId} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor="org-domain">{t('label')}</Label>
              <Input id="org-domain" name="domain" maxLength={253} autoComplete="off" />
            </div>
            <Button type="submit" variant="secondary">
              {t('add')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
