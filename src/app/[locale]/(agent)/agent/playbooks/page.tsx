import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { listActiveModules, listPlaybooks, PLAYBOOK_KEEPERS } from '@/modules/hdr/api';
import { TICKET_TYPES } from '@/modules/hdt/api';
import { namesOf, requireStaffActor } from '@/modules/hdu/api';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Card, CardContent } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Label } from '@/ui/components/label';
import { PageHeader } from '@/ui/components/PageHeader';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { savePlaybookAction } from './actions';

// Памятки первой линии (FR-LINE-10): "что проверить до передачи" по модулю и типу обращения. Читают все
// сотрудники, ведут вторая линия, care и admin (10.5). На этапе 2 памятки переедут во внутреннюю базу знаний (KB-54).

export default async function PlaybooksPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const staff = await requireStaffActor();
  const t = await getTranslations('agent');
  const format = await getFormatter();
  const { done, error } = await searchParams;
  const [list, modules] = await Promise.all([listPlaybooks(staff), listActiveModules(staff.actor, await getLocale())]);
  const owners = await namesOf(staff.actor, list.map((p) => p.ownerId));
  const canEdit = (PLAYBOOK_KEEPERS as readonly string[]).includes(staff.actor.staffRole);
  const moduleName = (id: string | null) => (id ? (modules.find((m) => m.moduleId === id)?.name ?? '') : t('playbooks.anyModule'));

  return (
    <>
      <PageHeader
        title={t('playbooks.title')}
        breadcrumbs={[{ label: t('home.title'), href: '/agent' }, { label: t('playbooks.title') }]}
        breadcrumbsLabel={t('breadcrumbs')}
      />
      <div className="flex max-w-3xl flex-col gap-4">
        {done === 'saved' && <Alert tone="success">{t('playbooks.saved')}</Alert>}
        {error && <Alert tone="danger">{t(error === 'forbidden' ? 'playbooks.errors.forbidden' : 'playbooks.errors.invalid_input')}</Alert>}
        <p className="text-secondary-foreground">{t('playbooks.intro')}</p>
        {list.length === 0 ? (
          <Card>
            <EmptyState title={t('playbooks.emptyTitle')} text={t('playbooks.emptyText')} />
          </Card>
        ) : (
          list.map((playbook) => (
            <Card key={playbook.playbookId}>
              <CardContent className="flex flex-col gap-2 pt-6">
                <h2 className="font-semibold">
                  {moduleName(playbook.moduleId)} / {t(`ticket.types.${playbook.type}`)}
                </h2>
                <ul className="list-disc ps-5 text-sm">
                  {playbook.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {t('playbooks.owner', { name: owners.get(playbook.ownerId) ?? '', time: format.dateTime(playbook.updatedOn, { dateStyle: 'medium' }) })}
                </p>
              </CardContent>
            </Card>
          ))
        )}
        {canEdit && (
          <Card>
            <CardContent className="pt-6">
              <form action={savePlaybookAction} className="flex flex-col gap-3">
                <h2 className="text-lg font-semibold">{t('playbooks.editTitle')}</h2>
                <p className="text-sm text-secondary-foreground">{t('playbooks.editHint')}</p>
                <div className="grid gap-3 tablet:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="playbook-module">{t('playbooks.module')}</Label>
                    <Select id="playbook-module" name="moduleId" defaultValue="">
                      <option value="">{t('playbooks.anyModule')}</option>
                      {modules.map((m) => (
                        <option key={m.moduleId} value={m.moduleId}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="playbook-type">{t('playbooks.type')}</Label>
                    <Select id="playbook-type" name="type" defaultValue="bug">
                      {TICKET_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`ticket.types.${type}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <Label htmlFor="playbook-body">{t('playbooks.body')}</Label>
                <Textarea id="playbook-body" name="body" required maxLength={10000} className="min-h-32" />
                <Button type="submit" className="self-end">
                  {t('playbooks.save')}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
