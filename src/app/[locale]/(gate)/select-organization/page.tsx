import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { signOutAction } from '@/app/[locale]/session-actions';
import { listMyOrganizations, requireSignedInClient, safeReturnPath } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Card, CardContent, CardHeader } from '@/ui/components/card';
import { selectOrganizationAction } from './actions';
import { firstParam } from '@/lib/search-params';
import { WidgetFragmentCapture } from '@/ui/widget/WidgetFragmentCapture';

// Выбор организации: у человека несколько организаций, и ни одна не выбрана (FR-ID-05).
// Список строится из действующих членств, выбор проверяет серверное действие.
export default async function SelectOrganizationPage({ searchParams }: PageProps<'/[locale]/select-organization'>) {
  const user = await requireSignedInClient();
  const params = await searchParams;
  const locale = await getLocale();
  const next = safeReturnPath(firstParam(params.next), `/${locale}`);
  const orgs = await listMyOrganizations(user.userId);
  if (orgs.length === 0) redirect(`/${locale}/no-organization`);

  const t = await getTranslations('auth.gate');
  return (
    <Card>
      <CardHeader>
        <WidgetFragmentCapture />
        <h1 className="text-xl font-semibold">{t('selectOrganization.title')}</h1>
        <p className="text-secondary-foreground">{t('selectOrganization.intro')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {firstParam(params.error) === 'not_member' && <Alert tone="danger">{t('selectOrganization.notMember')}</Alert>}
        <ul className="flex flex-col gap-3">
          {orgs.map((org) => (
            <li key={org.orgId}>
              <form action={selectOrganizationAction}>
                <input type="hidden" name="orgId" value={org.orgId} />
                <input type="hidden" name="next" value={next} />
                <button
                  type="submit"
                  className="flex min-h-control w-full flex-col items-start gap-1 rounded-control border border-input bg-card px-4 py-3 text-start outline-none transition-colors hover:bg-card-soft focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-semibold wrap-anywhere">{org.name}</span>
                  <span className="text-sm text-secondary-foreground">{t(`roles.${org.role}`)}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
        <form action={signOutAction} className="border-t border-border pt-4 text-center">
          <p className="mb-2 text-sm text-secondary-foreground">{t('signedInAs', { name: user.name })}</p>
          <button type="submit" className="text-sm font-medium text-link underline-offset-4 hover:underline">
            {t('signOut')}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
