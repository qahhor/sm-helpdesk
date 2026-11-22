import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { UnidentifiedItem } from '@/modules/hdt/api';
import type { OrgRow } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { bindAction, notClientAction, spamAction } from './actions';

// Панель привязки письма (экран по образцу 8.12): от кого, имя из письма, подсказка по домену, поиск организации по
// названию и ИНН, кнопки "Привязать и пригласить", "Это не клиент", "Спам". Роль product видит панель без кнопок.

type Props = { item: UnidentifiedItem; q: string; found: OrgRow[] | null; canWrite: boolean };

function BindButton({ number, orgId, label }: { number: number; orgId: string; label: string }) {
  return (
    <form action={bindAction}>
      <input type="hidden" name="number" value={number} />
      <input type="hidden" name="orgId" value={orgId} />
      <Button type="submit" size="small">
        {label}
      </Button>
    </form>
  );
}

export async function BindPanel({ item, q, found, canWrite }: Props) {
  const t = await getTranslations('agent.queues.unidentified');
  const format = await getFormatter();
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <h2 className="font-semibold">
          <Link href={`/agent/tickets/SUP-${item.number}`} className="text-link underline underline-offset-2">
            SUP-{item.number}
          </Link>{' '}
          {item.title}
        </h2>
        <div className="flex flex-col gap-1 text-sm">
          {item.fromAddress && <p className="break-all">{t('from', { address: item.fromAddress })}</p>}
          {item.fromName && <p>{t('name', { name: item.fromName })}</p>}
          <p className="text-muted-foreground">{t('received', { time: format.dateTime(item.createdOn, { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
        </div>
        <p className="text-sm text-secondary-foreground">{t('onlyNumber')}</p>
        {item.hint && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('hint', { name: item.hint.name })}</span>
            {canWrite && <BindButton number={item.number} orgId={item.hint.orgId} label={t('bindHint', { name: item.hint.name })} />}
          </div>
        )}
        {canWrite ? (
          <>
            <form method="get" className="flex flex-wrap items-end gap-2" role="search">
              <input type="hidden" name="number" value={item.number} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor="bind-org">{t('orgSearch')}</Label>
                <Input id="bind-org" name="q" defaultValue={q} maxLength={100} />
              </div>
              <Button type="submit" variant="secondary">
                {t('find')}
              </Button>
            </form>
            {found && found.length === 0 && <p className="text-sm text-muted-foreground">{t('notFound')}</p>}
            {found && found.length > 0 && (
              <ul className="flex flex-col gap-2" aria-label={t('results')}>
                {found.map((org) => (
                  <li key={org.orgId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      <span className="font-semibold">{org.name}</span>
                      {org.inn && <span className="text-muted-foreground"> · {org.inn}</span>}
                    </span>
                    <BindButton number={item.number} orgId={org.orgId} label={t('bind')} />
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              <form action={notClientAction}>
                <input type="hidden" name="number" value={item.number} />
                <Button type="submit" variant="secondary" size="small">
                  {t('notClient')}
                </Button>
              </form>
              <form action={spamAction}>
                <input type="hidden" name="number" value={item.number} />
                <Button type="submit" variant="ghost" size="small">
                  {t('spam')}
                </Button>
              </form>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
        )}
      </CardContent>
    </Card>
  );
}
