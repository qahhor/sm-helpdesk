import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { signOutAction } from '@/app/[locale]/session-actions';
import { SignOutForm } from '@/ui/shell/SignOutForm';
import { listMyOrganizations, requireSignedInClient } from '@/modules/hdu/api';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader } from '@/ui/components/card';

// Человек вошёл, но не состоит ни в одной действующей организации: Smartup не передал компанию,
// участника отключили или организацию закрыли. Кабинет ему не открывается, выйти можно всегда.
export default async function NoOrganizationPage() {
  const user = await requireSignedInClient();
  // Организация могла появиться (приглашение принято, участника включили): тогда в кабинет.
  if ((await listMyOrganizations(user.userId)).length > 0) redirect(`/${await getLocale()}`);

  const t = await getTranslations('auth.gate');
  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t('noOrganization.title')}</h1>
        <p className="text-secondary-foreground">{t('noOrganization.text')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-secondary-foreground">{t('signedInAs', { name: user.name })}</p>
        <SignOutForm action={signOutAction}>
          <Button type="submit" variant="secondary" className="w-full">
            {t('signOut')}
          </Button>
        </SignOutForm>
      </CardContent>
    </Card>
  );
}
