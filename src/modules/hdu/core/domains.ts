import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import type { StaffActor } from '@/db/with-actor';
import { withIdentity } from '@/db/with-identity';
import { writeAudit } from '@/modules/hdc/api';
import { HduError } from '../error';
import { orgEmailDomains } from '../schema';

// Модуль hdu, слой core: домены почты организации (FR-EM-06, решение 15 вехи M4). Письмо с такого домена при DMARC
// становится обращением этой организации от гостя. Добавляют и удаляют Customer Care и администратор (политики базы),
// каждое изменение в журнал. Один домен принадлежит одной организации.

export async function listOrgDomainsTx(actor: StaffActor, orgId: string): Promise<string[]> {
  const rows = await withIdentity(actor, (tx) =>
    tx.select({ domain: orgEmailDomains.domain }).from(orgEmailDomains).where(eq(orgEmailDomains.orgId, orgId)).orderBy(asc(orgEmailDomains.domain)),
  );
  return rows.map((row) => row.domain);
}

export async function addOrgDomainTx(actor: StaffActor, orgId: string, domain: string): Promise<void> {
  await withIdentity(actor, async (tx) => {
    const [owner] = await tx.select({ orgId: orgEmailDomains.orgId }).from(orgEmailDomains).where(eq(orgEmailDomains.domain, domain)).limit(1);
    if (owner?.orgId === orgId) return;
    if (owner) throw new HduError('domain_taken');
    await tx.insert(orgEmailDomains).values({ orgId, domain, addedBy: actor.userId });
    await writeAudit(tx, { action: 'org.domain_added', objectType: 'organization', objectId: orgId, orgId, diff: { domain } });
  });
}

export async function removeOrgDomainTx(actor: StaffActor, orgId: string, domain: string): Promise<void> {
  await withIdentity(actor, async (tx) => {
    const removed = await tx
      .delete(orgEmailDomains)
      .where(and(eq(orgEmailDomains.orgId, orgId), eq(orgEmailDomains.domain, domain)))
      .returning({ domain: orgEmailDomains.domain });
    if (removed.length > 0) await writeAudit(tx, { action: 'org.domain_removed', objectType: 'organization', objectId: orgId, orgId, diff: { domain } });
  });
}
