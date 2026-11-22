import { getTranslations } from 'next-intl/server';
import type { InboundTestStatus } from '@/modules/hdn/api/mail-settings';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { StatusLabel } from '@/ui/components/StatusLabel';
import { inboundTestAction, saveSupportAction } from './actions';

// Адреса поддержки (решение 23): список, показываемый адрес, проверка приёма каждого адреса и подсказка по записям DNS.

type Props = { addresses: { address: string; shown: boolean; test: InboundTestStatus }[]; intake: { domain: string; address: string } | null };

const TONE = { never: 'gray', waiting: 'orange', received: 'green' } as const;

export async function SupportAddresses({ addresses, intake }: Props) {
  const t = await getTranslations('agent.settings.mail.support');
  return (
    <section aria-labelledby="mail-support" className="flex flex-col gap-3">
      <h2 id="mail-support" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-secondary-foreground">{t('intro')}</p>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          {addresses.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
          {addresses.length > 0 && (
            <ul className="flex flex-col divide-y divide-border" aria-label={t('title')}>
              {addresses.map((item) => (
                <li key={item.address} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-address={item.address}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-semibold">{item.address}</span>
                    {item.shown && <StatusLabel tone="blue">{t('shown')}</StatusLabel>}
                    <StatusLabel tone={TONE[item.test]}>{t(`status.${item.test}`)}</StatusLabel>
                  </span>
                  <form action={inboundTestAction}>
                    <input type="hidden" name="address" value={item.address} />
                    <Button type="submit" variant="secondary" size="small">
                      {t('test')}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <form action={saveSupportAction} className="flex flex-col gap-3">
            {addresses.length > 0 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">{t('shown')}</legend>
                {addresses.map((item, index) => (
                  <div key={item.address} className="flex flex-wrap items-center gap-4 text-sm">
                    <input type="hidden" name="address" value={item.address} />
                    <label htmlFor={`shown-${index}`} className="flex items-center gap-2">
                      <input id={`shown-${index}`} type="radio" name="shown" value={item.address} defaultChecked={item.shown} className="size-4 accent-primary" />
                      <span className="break-all">{item.address}</span>
                    </label>
                    <label htmlFor={`remove-${index}`} className="flex items-center gap-2 text-secondary-foreground">
                      <input id={`remove-${index}`} type="checkbox" name="remove" value={item.address} className="size-4 accent-primary" />
                      {t('remove')}
                    </label>
                  </div>
                ))}
              </fieldset>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="support-new">{t('add')}</Label>
              <Input id="support-new" name="newAddress" type="email" maxLength={320} autoComplete="off" />
            </div>
            <Button type="submit" className="self-start">
              {t('save')}
            </Button>
          </form>
          <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm text-secondary-foreground">
            <h3 className="font-medium text-foreground">{t('hintTitle')}</h3>
            {intake ? (
              <ul className="list-disc ps-5">
                <li>{t('hintMx', { domain: intake.domain })}</li>
                <li>{t('hintSend')}</li>
                <li>{t('hintForward', { intake: intake.address })}</li>
              </ul>
            ) : (
              <p>{t('hintOff')}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
